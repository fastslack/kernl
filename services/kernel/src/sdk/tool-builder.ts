import { z, ZodError } from "zod";
import type { ToolResult, ToolDefinition, ToolCost, ToolInverse } from "../core/types.js";
import { errorResult, extractErrorMessage, formatZodError } from "./helpers.js";

/**
 * Apply forgiving coercion for the LLM mistakes that show up most often in
 * tool-call validation:
 *   - `Expected number, received string`  → parse numeric string with Number()
 *   - `Expected boolean, received string` → "true"/"false" → boolean
 *   - `Expected array, received string`   → JSON.parse when it yields an array
 *   - `Expected object, received string`  → JSON.parse when it yields an object
 *
 * Mutates a shallow clone of `args` along the issue's `path` and returns the
 * new object. Returns `null` when no path was coercible — caller should give
 * up and let the original ZodError surface so the LLM sees the error and can
 * self-correct on the next iteration.
 *
 * The array/object cases are not cosmetic. Some agent executors serialise
 * nested arguments before the call arrives here, so `at: [5, 8, 4]` reaches
 * validation as the string `"[5, 8, 4]"` and EVERY array or object parameter in
 * the kernel fails for those agents. That failure is unrecoverable from the
 * agent's side: it cannot observe how its arguments were serialised, the error
 * names the value it believes it sent, and every retry fails the same way — a
 * drawing agent hit exactly this and could create a scene but never put an
 * object into one.
 *
 * Enum / unknown-field / range issues are intentionally NOT coerced — those
 * indicate genuine LLM hallucinations (e.g. inventing a `"pending"` status),
 * and silently dropping them would mask broken behaviour. Same principle
 * bounds the JSON cases: the string must actually parse, and parse to the
 * shape that was asked for, or it is left alone for the error to surface.
 */
export function coerceCommonZodIssues(args: unknown, issues: Array<{
  code: string; path: (string | number)[]; expected?: string; received?: string;
}>): Record<string, unknown> | null {
  if (!args || typeof args !== "object") return null;
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(args));
  let mutated = false;

  for (const iss of issues) {
    if (iss.code !== "invalid_type") continue;
    if (!Array.isArray(iss.path) || iss.path.length === 0) continue;
    if (iss.received !== "string") continue;

    // Walk to the parent of the offending field.
    let parent: any = out;
    for (let i = 0; i < iss.path.length - 1; i++) {
      const key = iss.path[i];
      if (parent == null || typeof parent !== "object") { parent = null; break; }
      parent = parent[key as keyof typeof parent];
    }
    if (parent == null || typeof parent !== "object") continue;
    const leaf = iss.path[iss.path.length - 1];
    const raw = parent[leaf as keyof typeof parent];
    if (typeof raw !== "string") continue;

    if (iss.expected === "number") {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const n = Number(trimmed);
      if (Number.isFinite(n)) { parent[leaf as keyof typeof parent] = n; mutated = true; }
    } else if (iss.expected === "boolean") {
      const v = raw.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes")       { parent[leaf as keyof typeof parent] = true;  mutated = true; }
      else if (v === "false" || v === "0" || v === "no")  { parent[leaf as keyof typeof parent] = false; mutated = true; }
    } else if (iss.expected === "array" || iss.expected === "object") {
      // Only touch text that is trying to be JSON of the requested shape. The
      // opening-bracket check keeps `JSON.parse` away from prose and from bare
      // scalars like "7" or "null" — the latter being an object by `typeof`
      // and, unhandled, a null that fails further from its cause.
      const trimmed = raw.trim();
      const opener = iss.expected === "array" ? "[" : "{";
      if (!trimmed.startsWith(opener)) continue;
      try {
        const value = JSON.parse(trimmed);
        const fits = iss.expected === "array"
          ? Array.isArray(value)
          : value !== null && typeof value === "object" && !Array.isArray(value);
        if (fits) { parent[leaf as keyof typeof parent] = value; mutated = true; }
      } catch {
        // Not JSON after all — leave it for the original error to explain.
      }
    }
  }

  return mutated ? out : null;
}

interface ToolMeta {
  tags?: string[];
  sideEffects?: string[];
  cost?: ToolCost;
  inverse?: ToolInverse;
  outputSchema?: z.ZodType<unknown>;
}

/**
 * Parse a tool's args the way the MCP dispatch does, for the paths that call
 * `handler` directly (the agent loop, the WS bridge):
 *
 * - The same forgiving coercion. The dispatch retries with
 *   coerceCommonZodIssues. Without it here, a `"5"` an LLM sent for a number
 *   would pass over MCP and fail from an agent.
 * - `__` keys are kept. AgentExecutor injects `__caller_agent_id` and friends
 *   straight into a handler's args, and a caller-aware tool reads them. The
 *   schema would strip them. External paths strip `__` keys before they get
 *   here (see stripInternalArgs), so this only ever passes on what the kernel
 *   itself put there.
 */
function parseToolArgs<T extends z.ZodType>(schema: T, args: unknown): z.infer<T> {
  let safe = schema.safeParse(args);
  if (!safe.success) {
    const coerced = coerceCommonZodIssues(args, safe.error.issues as Parameters<typeof coerceCommonZodIssues>[1]);
    if (!coerced) throw safe.error;
    safe = schema.safeParse(coerced);
    if (!safe.success) throw safe.error;
  }
  const parsed = safe.data as z.infer<T>;
  if (typeof args !== "object" || args === null || typeof parsed !== "object" || parsed === null) return parsed;
  const internal = Object.entries(args).filter(([key]) => key.startsWith("__"));
  return internal.length ? { ...parsed, ...Object.fromEntries(internal) } : parsed;
}

/**
 * Type-safe tool builder that infers handler input types from Zod schema.
 *
 * Eliminates manual `as {...}` casts in tool handlers by inferring the
 * input type directly from the Zod schema at compile time.
 *
 * Errors thrown by the handler or validation failures are caught and
 * converted to errorResult() responses.
 *
 * @example
 * ```typescript
 * const CreateTaskSchema = z.object({
 *   title: z.string(),
 *   description: z.string().optional(),
 * });
 *
 * export const createTask = defineTool({
 *   name: "kernel_tasks_create",
 *   description: "Create a new task",
 *   schema: CreateTaskSchema,
 *   tags: ["tasks"],
 *   sideEffects: ["task.created:1"],
 *   handler: async (input) => {
 *     // input is automatically typed as { title: string; description?: string }
 *     const task = service.create(input.title, input.description);
 *     return textResult(`Created: ${task.id}`);
 *   },
 * });
 * ```
 */
export function defineTool<T extends z.ZodType>(config: ToolMeta & {
  name: string;
  description: string;
  schema: T;
  handler: (input: z.infer<T>) => Promise<ToolResult>;
}): ToolDefinition {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.schema,
    ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
    ...(config.tags ? { tags: config.tags } : {}),
    ...(config.sideEffects ? { sideEffects: config.sideEffects } : {}),
    ...(config.cost ? { cost: config.cost } : {}),
    ...(config.inverse ? { inverse: config.inverse } : {}),
    handler: async (args: unknown) => {
      try {
        return await config.handler(parseToolArgs(config.schema, args));
      } catch (err) {
        if (err instanceof ZodError) return errorResult(formatZodError(err));
        return errorResult(extractErrorMessage(err));
      }
    },
  };
}

/**
 * Type-safe tool builder for tools with no input parameters.
 *
 * Errors thrown by the handler are caught and converted to errorResult() responses.
 *
 * @example
 * ```typescript
 * export const listAll = defineToolNoInput({
 *   name: "kernel_tasks_list_all",
 *   description: "List all tasks",
 *   tags: ["tasks"],
 *   handler: async () => {
 *     const tasks = service.listAll();
 *     return textResult(formatTasks(tasks));
 *   },
 * });
 * ```
 */
export function defineToolNoInput(config: ToolMeta & {
  name: string;
  description: string;
  handler: () => Promise<ToolResult>;
}): ToolDefinition {
  return defineTool({ ...config, schema: z.object({}), handler: async () => config.handler() });
}

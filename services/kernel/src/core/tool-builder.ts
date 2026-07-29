import { z, ZodError } from "zod";
import type { ToolResult, ToolDefinition, ToolCost, ToolInverse } from "./types.js";
import { errorResult, extractErrorMessage, formatZodError } from "./helpers.js";

interface ToolMeta {
  tags?: string[];
  sideEffects?: string[];
  cost?: ToolCost;
  inverse?: ToolInverse;
  outputSchema?: z.ZodType<unknown>;
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
        const parsed = config.schema.parse(args);
        return await config.handler(parsed);
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

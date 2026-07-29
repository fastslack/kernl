import { v4 as uuidv4 } from "uuid";
import type { ZodError } from "zod";
import type { ToolResult } from "./types.js";
import { log } from "./logger.js";

// ── MCP Result Helpers ────────────────────────────────────────

/** Wrap a plain-text response for MCP */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Wrap an error response for MCP */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wrap a structured (JSON) response. Emits both the human-readable text
 * (for legacy clients) and a typed `structuredContent` payload that
 * clients on protocol ≥ 2025-03-26 can use directly without parsing.
 *
 * Pair with a tool that declared an `outputSchema` for first-class
 * programmatic tool calling.
 */
export function structuredResult<T>(value: T, text?: string): ToolResult {
  const display = text ?? JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text: display }],
    structuredContent: value,
  };
}

/**
 * Wrap a UI-content response for "MCP applications". Emits the canonical
 * text for back-compat plus an opt-in `ui` block (HTML or component JSON)
 * that capable clients render as a real surface.
 */
export function uiResult(text: string, mimeType: string, body: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    ui: { mimeType, body },
  };
}

// ── ID & Time Helpers ─────────────────────────────────────────

/** Generate a v4 UUID */
export function newId(): string {
  return uuidv4();
}

/** Format a Date as ISO string (UTC) */
export function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Canonical slug builder — lowercase, accent-stripped, hyphen-separated,
 * trimmed to 48 chars. Accent folding via NFD so "Análisis" → "analisis".
 *
 * NOTE: this is the office-kit flavour (no min-length fallback). Some call
 * sites need different semantics (reverse-DNS min-length fallbacks, longer
 * slice) and intentionally keep their own local slugify — see
 * modules/extensions/legacy-import.ts and modules/marketplace/catalog/normalizers.ts.
 */
export function slugify(text: string): string {
  return text
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// ── Async Helpers ─────────────────────────────────────────────

/**
 * Execute a promise without awaiting, logging errors at debug level.
 *
 * Use this for fire-and-forget operations where you don't want to
 * block the main flow but still want visibility into failures.
 *
 * @param promise - The promise to execute
 * @param context - Optional context string for debugging (e.g., "neo4j:task-sync")
 *
 * @example
 * ```typescript
 * // Instead of: this.events.emit("data.changed", data).catch(() => {});
 * fireAndForget(
 *   this.events.emit("data.changed", data),
 *   "emit:data.changed"
 * );
 *
 * // Neo4j sync that shouldn't block the response
 * fireAndForget(
 *   this.neo4j.run(`MERGE (t:Task {id: $id})...`, { id }),
 *   "neo4j:task-sync"
 * );
 * ```
 */
export function fireAndForget(
  promise: Promise<unknown>,
  context?: string
): void {
  promise.catch((err) => {
    const prefix = context ? `[${context}] ` : "";
    log.debug(`${prefix}fire-and-forget error:`, err);
  });
}

/**
 * Execute a promise with a timeout.
 *
 * @param promise - The promise to execute
 * @param timeoutMs - Timeout in milliseconds
 * @param errorMessage - Custom error message for timeout
 * @returns The resolved value or throws on timeout
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   fetch(url),
 *   5000,
 *   "API request timed out"
 * );
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = "Operation timed out"
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

// ── Error Helpers ─────────────────────────────────────────────

/**
 * Extract error message from unknown error type.
 *
 * @param err - The caught error (unknown type)
 * @returns A string message suitable for logging or display
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (err) {
 *   return errorResult(extractErrorMessage(err));
 * }
 * ```
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return String(err);
}

/**
 * Format a ZodError as a human-readable one-liner instead of the raw
 * multi-line JSON issue array.
 *
 * @example
 * ```typescript
 * try {
 *   schema.parse(args);
 * } catch (err) {
 *   if (err instanceof ZodError) return errorResult(formatZodError(err));
 * }
 * ```
 */
export function formatZodError(err: ZodError): string {
  const issues = err.issues;
  if (!issues || issues.length === 0) {
    return `Invalid input: ${err.message}`;
  }
  const parts = issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return `Invalid input: ${parts.join(", ")}`;
}

// ── Internal-arg hygiene ────────────────────────────────────────

/**
 * Strip every top-level key starting with `__` from a tool-call args
 * object before it is validated against the tool's schema.
 *
 * Double-underscore keys (`__caller_agent_id`, `__caller_run_id`, ...) are
 * a kernel-internal injection channel: `AgentExecutor.executeTool()` adds
 * them to the args it hands directly to a `ToolDefinition.handler`,
 * bypassing this dispatch path entirely. Some tool schemas declare these
 * fields explicitly (as optional) so they survive `schema.parse()` on the
 * agent-loop path — but that same declaration means a naive `safeParse`
 * on externally-supplied args would let an MCP client set
 * `__caller_agent_id` itself and impersonate any agent. Call this
 * immediately before parsing external args so those keys can never
 * originate from outside the process.
 */
export function stripInternalArgs(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return args;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (!key.startsWith("__")) out[key] = value;
  }
  return out;
}

/**
 * Server-initiated elicitation helper.
 *
 * MCP's `elicitation/create` lets a tool, *mid-execution*, ask the user
 * (via the client) for additional structured input — instead of failing
 * with "missing field X" or guessing a default. The client renders a
 * form, the user fills it in, and the tool resumes with the value.
 *
 * The wire-level mechanism is on the SDK's `Server` instance:
 *   await server.elicitInput({ message, requestedSchema }, { ... })
 *
 * To keep tool handler signatures unchanged, we propagate the live
 * `Server` through `AsyncLocalStorage` (same pattern as
 * `request-context.ts`). Server.ts wraps every CallTool dispatch with
 * `runWithServer(server, fn)`, so any handler can call `elicit(...)`
 * without plumbing the server reference through.
 *
 * ## Capability negotiation
 *
 * The SDK throws if the connected client didn't declare the
 * `elicitation` capability in `initialize`. We catch that and surface a
 * clear, structured error so handlers can decide whether to fall back
 * (e.g. use a default) or hard-fail.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

const storage = new AsyncLocalStorage<Server>();

/** Run `fn` with `server` available to any nested `elicit(...)` call. */
export function runWithServer<T>(server: Server, fn: () => T): T {
  return storage.run(server, fn);
}

/** Get the current Server instance, or null if no elicitation context is active. */
export function getCurrentServer(): Server | null {
  return storage.getStore() ?? null;
}

// ── Schema shorthands ──────────────────────────────────────────────────
// MCP elicitation only allows top-level *primitive* schemas (strings,
// numbers, booleans, enums, arrays of strings). Reproducing the SDK's
// massive zod schema here would be redundant — these helpers cover the
// 95% case and accept any extra JSON Schema fields via `extras`.

export type ElicitField =
  | { type: "string"; title?: string; description?: string; format?: "date" | "uri" | "email"; minLength?: number; maxLength?: number; default?: string }
  | { type: "string"; title?: string; description?: string; enum: string[]; enumNames?: string[]; default?: string }
  | { type: "number"; title?: string; description?: string; minimum?: number; maximum?: number; default?: number }
  | { type: "integer"; title?: string; description?: string; minimum?: number; maximum?: number; default?: number }
  | { type: "boolean"; title?: string; description?: string; default?: boolean };

export interface ElicitParams {
  /** Human-readable prompt shown above the form. */
  message: string;
  /** Map of field name → field schema. Order is the form order. */
  fields: Record<string, ElicitField>;
  /** Required field names. Anything not in this list is optional. */
  required?: string[];
}

export type ElicitOutcome<T = Record<string, unknown>> =
  | { action: "accept"; content: T }
  | { action: "decline"; content?: undefined }
  | { action: "cancel"; content?: undefined }
  | { action: "unsupported"; reason: string };

/**
 * Ask the connected client to elicit structured input from the user.
 *
 * Returns `{ action }` matching the spec: `accept` with the user-provided
 * `content`, `decline` (user said no), `cancel` (user dismissed), or
 * `unsupported` (no client capability, no active context, or wire error).
 *
 * Tool handlers should always handle the `unsupported` branch — many MCP
 * clients (CLIs especially) won't declare elicitation, and the right
 * fallback (use default, error out, etc.) is per-tool.
 */
export async function elicit<T = Record<string, unknown>>(
  params: ElicitParams,
): Promise<ElicitOutcome<T>> {
  const server = getCurrentServer();
  if (!server) {
    return { action: "unsupported", reason: "no active server context" };
  }
  try {
    const result = await server.elicitInput({
      mode: "form",
      message: params.message,
      requestedSchema: {
        type: "object",
        properties: params.fields as unknown as Record<string, never>,
        required: params.required ?? [],
      },
    });
    if (result.action === "accept") {
      return { action: "accept", content: (result.content ?? {}) as T };
    }
    if (result.action === "decline") return { action: "decline" };
    return { action: "cancel" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: "unsupported", reason: message };
  }
}

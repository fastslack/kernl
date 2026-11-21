/**
 * Per-request context propagated through the call stack via AsyncLocalStorage.
 *
 * The MCP HTTP server (subprocess agents call into the kernel via HTTP) lifts
 * `X-Caller-Agent-Id`, `X-Caller-Run-Id`, and `X-Caller-Depth` headers off the
 * request and stashes them here. Tool handlers like `kernel_agents_run` and
 * `kernel_agents_invoke` read them to:
 *   - Reject self-invocation (caller agent === target agent).
 *   - Increment depth on chained runs (caller depth + 1).
 *   - Trace lineage by passing parent_run_id through to createRun.
 *
 * Why AsyncLocalStorage instead of plumbing through ToolDefinition.handler:
 * tool handlers are written once and used across stdio + HTTP transports;
 * widening the signature would cascade through every module. ALS keeps the
 * change isolated to the HTTP boundary.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Principal } from "./principal.js";

export interface KernelRequestContext {
  /** Agent that owns the subprocess making this MCP call. "" if absent. */
  callerAgentId: string;
  /** Run that owns this MCP call. "" if absent. */
  callerRunId: string;
  /** Depth of the caller's run. 0 if absent. */
  callerDepth: number;
  /**
   * Who made the request: set at the HTTP boundary (`/api/*`, `/mcp`) once
   * the token is checked. Absent for work the kernel starts on its own
   * (scheduled agents, triggers) and for the Unix-socket and stdio
   * transports, whose callers are local processes.
   */
  principal?: Principal;
}

const storage = new AsyncLocalStorage<KernelRequestContext>();

/** Run a callback with the given caller context active. */
export function runWithContext<T>(ctx: KernelRequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Read the current caller context, or an empty default if none is active. */
export function getRequestContext(): KernelRequestContext {
  return (
    storage.getStore() ?? {
      callerAgentId: "",
      callerRunId: "",
      callerDepth: 0,
    }
  );
}

/** The principal of the request in flight, or null outside one. */
export function getPrincipal(): Principal | null {
  return storage.getStore()?.principal ?? null;
}

/**
 * What the job-hunter handlers run on.
 *
 * The slice of the kernel's builtin-handler context these handlers used when
 * they lived in core (`db`, `notifier`, `config`, the agent-advanced
 * WorkspaceService), built from the extension's ModuleContext — the same
 * sqlite handle, notifier and config object the kernel handed its builtins.
 */

import { csvList, type AgentDriverResult, type KernelConfig, type Notifier, type SqliteDb } from "@kernl/extension-sdk";

export interface JobHunterContext {
  db: SqliteDb;
  notifier: Pick<Notifier, "send">;
  config: KernelConfig;
  /**
   * agent-advanced's WorkspaceService, looked up when a run needs it (null
   * when that extension is not active). Only the dispatcher uses it, to file
   * proposals in a "proposals" workspace.
   */
  workspaceService?: () => unknown;
}

/** A no-LLM handler body: result text for the run log (= success). */
export type JobHandler = () => Promise<AgentDriverResult>;

/** A comma-separated variable as a lowercased keyword list ([] when not a string). */
export function parseCsv(v: unknown): string[] {
  return csvList(v).map((s) => s.toLowerCase());
}

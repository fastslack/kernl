/**
 * Whether the graph is over the size ceiling set on System › Storage (see
 * graph-budget.ts). While it is, nothing new is written to the graph: the
 * embedder and the projection do not start. No imports on purpose — the
 * service and both runners read it.
 */
import type { SqliteDb } from "@kernl/extension-sdk";

export function isGraphFrozen(db: SqliteDb): boolean {
  try {
    const row = db.prepare("SELECT value FROM cinema_graph_state WHERE key = 'frozen'").get() as { value: string } | undefined;
    return row?.value === "1";
  } catch {
    return false;
  }
}

export const GRAPH_FROZEN_MESSAGE = "the graph is at its size ceiling (System › Storage): nothing new is added until it is back under";

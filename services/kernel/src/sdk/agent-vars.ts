/**
 * Tunables of a built-in (no-LLM) agent handler.
 *
 * A handler's per-instance config lives in the `variables` JSON column of the
 * agent row that runs it, so the operator can edit it from the dashboard and
 * the next run picks it up without a restart. Pure: takes the database handle
 * the caller already has, so kernel handlers and extension drivers read it the
 * same way.
 */

import type { SqliteDb } from "../core/db/sqlite.js";
import { safeQueryOne } from "./query-helpers.js";
import { jsonObject } from "./helpers.js";

/**
 * The variables of the agent running built-in handler `handler` (the first
 * one, if several carry it), {} when there is no such agent or its
 * variables are unreadable. Built-in handlers read their tunables this way.
 */
export function readHandlerVars(db: SqliteDb, handler: string): Record<string, unknown> {
  const row = safeQueryOne<{ variables: string }>(
    db,
    "SELECT variables FROM agents WHERE builtin_handler = ? LIMIT 1",
    handler,
  );
  return row ? jsonObject(row.variables) : {};
}

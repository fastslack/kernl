/**
 * Edition: whether this Kernl runs as a personal assistant or a business one.
 *
 * The choice decides which free extensions start active and what context the
 * agents get. It never blocks anything — every extension can still be turned
 * on by hand. State lives in `edition_state` (created by the extensions
 * module's migrations), not app_settings: ConfigService.set mirrors every key
 * into .env and process.env, which this has no business doing.
 */
import type { Audience } from "../modules/extensions/types.js";
import type { SqliteDb } from "./db/sqlite.js";

export type EditionMode = Audience;

const BOTH: Audience[] = ["personal", "business"];

/** A manifest's audience, with absent/empty meaning both. */
export function audienceOf(manifest: { audience?: Audience[] } | null | undefined): Audience[] {
  const a = manifest?.audience;
  return a && a.length > 0 ? [...a] : [...BOTH];
}

export interface EditionState {
  mode: EditionMode | null;
  /** Install predates editions: choosing one only ever adds. */
  legacy: boolean;
  /** Extension ids the edition disabled (and may re-enable). */
  parked: string[];
}

const EMPTY: EditionState = { mode: null, legacy: false, parked: [] };

export function readEditionState(db: SqliteDb): EditionState {
  let rows: Array<{ key: string; value: string }>;
  try {
    rows = db.prepare("SELECT key, value FROM edition_state").all() as Array<{ key: string; value: string }>;
  } catch {
    return { ...EMPTY, parked: [] };
  }
  const kv = new Map(rows.map((r) => [r.key, r.value]));
  const mode = kv.get("mode");
  let parked: string[] = [];
  try {
    const parsed = JSON.parse(kv.get("parked") ?? "[]");
    if (Array.isArray(parsed)) parked = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    parked = [];
  }
  return {
    mode: mode === "personal" || mode === "business" ? mode : null,
    legacy: kv.get("legacy") === "1",
    parked,
  };
}

export function readEditionMode(db: SqliteDb): EditionMode | null {
  return readEditionState(db).mode;
}

export function writeEditionState(db: SqliteDb, patch: { mode?: EditionMode; parked?: string[] }): void {
  const put = db.prepare(
    "INSERT INTO edition_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  if (patch.mode !== undefined) put.run("mode", patch.mode);
  if (patch.parked !== undefined) put.run("parked", JSON.stringify(patch.parked));
}

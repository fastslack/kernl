// src/modules/panels/sources.ts
/**
 * Where a panel's data comes from. state-file: a JSON the office keeps in its
 * own folder, read-only and confined to it. collection: records agents of the
 * same office wrote with kernel_panel_record_*. channel: a module's dashboard
 * channel, live from its tables.
 */
import { createHash } from "node:crypto";
import { realpathSync, statSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { validateLite, stripSecrets } from "./jsonschema-lite.js";
import type { PanelSource } from "./spec.js";
import type { PanelStore } from "./store.js";

export const MAX_SOURCE_BYTES = 1_048_576;

export class SourceError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

function insideRoot(rootDir: string, rel: string): string {
  if (!rootDir) throw new SourceError("this office has no folder to read state files from", 409);
  let root: string;
  try { root = realpathSync(rootDir); } catch { throw new SourceError("office folder not found", 404); }
  const candidate = resolve(root, rel);
  if (candidate !== root && !candidate.startsWith(root + sep)) throw new SourceError("path leaves the office folder", 403);
  let real: string;
  try { real = realpathSync(candidate); } catch { throw new SourceError(`${rel} not found`, 404); }
  if (!real.startsWith(root + sep)) throw new SourceError("path leaves the office folder", 403);
  return real;
}

function readStateFile(src: Extract<PanelSource, { type: "state-file" }>, rootDir: string): { version: string; data: unknown } {
  const file = insideRoot(rootDir, src.path);
  const st = statSync(file);
  if (!st.isFile()) throw new SourceError(`${src.path} is not a file`, 422);
  if (st.size > MAX_SOURCE_BYTES) throw new SourceError(`${src.path} is too large (${st.size} bytes)`, 413);
  let data: unknown;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { throw new SourceError(`${src.path} is not valid JSON`, 422); }
  if (src.schema) {
    const errs = validateLite(src.schema, data);
    if (errs.length) throw new SourceError(`${src.path}: ${errs.slice(0, 5).join("; ")}`, 422);
  }
  return { version: `${st.mtimeMs}-${st.size}`, data: stripSecrets(src.schema, data) };
}

/** Reads a module's dashboard channel; undefined when no module registers it. */
export type ChannelReader = (name: string, params: Record<string, string>) => Promise<unknown>;

export async function readChannelSource(src: Extract<PanelSource, { type: "channel" }>, read: ChannelReader | undefined): Promise<{ version: string; data: unknown }> {
  if (!read) throw new SourceError("module channels are not available", 503);
  const data = await read(src.name, src.params ?? {});
  if (data === undefined || data === null) throw new SourceError(`channel ${src.name} is not available (is its module installed?)`, 404);
  const json = JSON.stringify(data);
  if (json.length > MAX_SOURCE_BYTES) throw new SourceError(`channel ${src.name} is too large (${json.length} bytes)`, 413);
  if (src.schema) {
    const errs = validateLite(src.schema, data);
    if (errs.length) throw new SourceError(`${src.name}: ${errs.slice(0, 5).join("; ")}`, 422);
  }
  // No mtime to lean on: the content is the version, so `since` still saves the transfer.
  return { version: createHash("sha1").update(json).digest("hex").slice(0, 16), data: stripSecrets(src.schema, data) };
}

export function readSource(
  src: Exclude<PanelSource, { type: "channel" }>,
  ctx: { owner: string; rootDir: string; store: PanelStore },
): { version: string; data: unknown } {
  if (src.type === "state-file") return readStateFile(src, ctx.rootDir);
  // A map keyed by record key, newest first: rows for tables and timelines, and
  // `$[{{key}}]` opens one record in a detail view.
  const map: Record<string, unknown> = {};
  for (const r of ctx.store.listRecords(ctx.owner, src.name, 500)) {
    const body = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : { value: r.data };
    map[r.key] = stripSecrets(src.schema, { ...body, updated_at: r.updated_at, updated_by: r.updated_by });
  }
  return { version: ctx.store.collectionVersion(ctx.owner, src.name), data: map };
}

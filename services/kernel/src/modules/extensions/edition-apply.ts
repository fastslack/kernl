/**
 * Carry out an edition choice against the installed extensions and persist it.
 * The decision itself is planEdition (pure); this file only executes it, one
 * extension at a time, so one failure leaves the rest applied and is reported.
 */
import type { SqliteDb } from "../../core/db/sqlite.js";
import { log } from "../../core/logger.js";
import { audienceOf, readEditionState, writeEditionState, type EditionMode } from "../../core/edition.js";
import { isPaidExtension } from "./entitlement.js";
import { planEdition, type EditionRow } from "./edition-plan.js";
import type { ExtensionService } from "./service.js";
import type { ExtensionManifest } from "./types.js";

export type ExtensionsPort = Pick<ExtensionService, "list" | "enable" | "disable">;

export interface EditionSummary {
  mode: EditionMode | null;
  legacy: boolean;
  parked: number;
  activated: string[];
  deactivated: string[];
  failed: Array<{ id: string; error: string }>;
}

export function editionStatus(db: SqliteDb): { mode: EditionMode | null; legacy: boolean; parked: number } {
  const s = readEditionState(db);
  return { mode: s.mode, legacy: s.legacy, parked: s.parked.length };
}

function toRow(r: ReturnType<ExtensionsPort["list"]>[number]): EditionRow {
  let manifest: Partial<ExtensionManifest> = {};
  try {
    manifest = JSON.parse(r.manifest_json) as Partial<ExtensionManifest>;
  } catch {
    manifest = {};
  }
  return {
    id: r.id,
    status: r.status,
    audience: audienceOf(manifest),
    paid: isPaidExtension({ slug: r.slug, pricing: manifest.pricing ?? null }),
    requiresActivation: manifest.requires_activation === true,
  };
}

export async function applyEdition(
  db: SqliteDb,
  ext: ExtensionsPort,
  mode: EditionMode,
  opts: { addOnly?: boolean } = {},
): Promise<EditionSummary> {
  const state = readEditionState(db);
  const firstApply = !opts.addOnly && state.mode === null && !state.legacy;
  const plan = planEdition({ mode, firstApply, rows: ext.list().map(toRow), parked: state.parked });

  const failed: EditionSummary["failed"] = [];
  const deactivated: string[] = [];
  for (const id of plan.deactivate) {
    try {
      await ext.disable(id);
      deactivated.push(id);
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const activated: string[] = [];
  for (const id of plan.activate) {
    try {
      await ext.enable(id);
      activated.push(id);
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Parked = what the plan parked, minus deactivations that failed (still
  // active), plus activations that failed (still disabled, still ours).
  const failedIds = new Set(failed.map((f) => f.id));
  const parked = [
    ...plan.parked.filter((id) => !(plan.deactivate.includes(id) && failedIds.has(id))),
    ...plan.activate.filter((id) => failedIds.has(id)),
  ];
  writeEditionState(db, { mode, parked });
  log.info(`Edition set to ${mode}: +${activated.length} -${deactivated.length}, ${failed.length} failed`);

  return { mode, legacy: state.legacy, parked: parked.length, activated, deactivated, failed };
}

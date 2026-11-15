/**
 * Carry out an edition choice against the installed extensions and persist it.
 * The decision itself is planEdition (pure); this file only executes it, one
 * extension at a time, so one failure leaves the rest applied and is reported.
 */
import type { SqliteDb } from "../../core/db/sqlite.js";
import { log } from "../../core/logger.js";
import { audienceOf, readEditionState, writeEditionState, type EditionMode } from "../../core/edition.js";
import { isPaidExtension } from "./entitlement.js";
import { hiddenNavGroups, planEdition, type EditionRow } from "./edition-plan.js";
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
  /** Sidebar groups this edition hides by default (the user can show them again). */
  hiddenGroups: string[];
}

export interface EditionStatus {
  mode: EditionMode | null;
  legacy: boolean;
  parked: number;
  hiddenGroups: string[];
}

/** Computed live, so an extension installed or toggled later counts at once. */
export function editionStatus(db: SqliteDb, ext: Pick<ExtensionsPort, "list">): EditionStatus {
  const s = readEditionState(db);
  return {
    mode: s.mode,
    legacy: s.legacy,
    parked: s.parked.length,
    hiddenGroups: hiddenNavGroups(s.mode, ext.list().map(toRow)),
  };
}

/** Group ids a manifest puts in the sidebar: `nav`, `navGroups` and `navItems` (the last two are not typed on FrontendBlock). */
function navGroupsOf(manifest: Partial<ExtensionManifest>): string[] {
  const fe = (manifest.frontend ?? {}) as {
    nav?: { group?: unknown };
    navGroups?: Array<{ id?: unknown }>;
    navItems?: Array<{ group?: unknown }>;
  };
  const ids = [
    fe.nav?.group,
    ...(Array.isArray(fe.navGroups) ? fe.navGroups.map((g) => g?.id) : []),
    ...(Array.isArray(fe.navItems) ? fe.navItems.map((i) => i?.group) : []),
  ];
  return [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
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
    navGroups: navGroupsOf(manifest),
  };
}

export async function applyEdition(
  db: SqliteDb,
  ext: ExtensionsPort,
  mode: EditionMode,
  // Kept for older clients: the edition never deactivates anything any more.
  _opts: { addOnly?: boolean } = {},
): Promise<EditionSummary> {
  const state = readEditionState(db);
  const plan = planEdition({ mode, rows: ext.list().map(toRow), parked: state.parked });

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

  return {
    mode, legacy: state.legacy, parked: parked.length, activated, deactivated, failed,
    hiddenGroups: hiddenNavGroups(mode, ext.list().map(toRow)),
  };
}

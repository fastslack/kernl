/**
 * Pure decisions behind the personal/business edition.
 *
 * The edition never turns an extension off. What it decides is which sidebar
 * menus start hidden (hiddenNavGroups): a menu whose every active contributor
 * is for the other audience. The user can show any of them again from
 * Settings → General → Menu, and the extensions behind them keep running.
 *
 * Installs from before this rule may still hold extensions the edition parked
 * (disabled). planEdition only ever un-parks them: a later choice re-activates
 * the parked rows its audience covers, and nothing is ever deactivated.
 */
import type { Audience, ExtensionStatus } from "./types.js";
import type { EditionMode } from "../../core/edition.js";

export interface EditionRow {
  id: string;
  status: ExtensionStatus;
  audience: Audience[];
  paid: boolean;
  /** Manifest asks to stay idle until the user turns it on. */
  requiresActivation: boolean;
  /** Sidebar group ids the manifest declares or puts items in. */
  navGroups: string[];
}

export interface EditionPlanInput {
  mode: EditionMode;
  rows: EditionRow[];
  parked: string[];
}

export interface EditionPlan {
  activate: string[];
  deactivate: string[];
  /** Ids disabled by the edition after this plan runs. */
  parked: string[];
}

export function planEdition({ mode, rows, parked }: EditionPlanInput): EditionPlan {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const stillParked = parked.filter((id) => byId.get(id)?.status === "disabled");
  const activate = stillParked.filter((id) => byId.get(id)!.audience.includes(mode));
  return {
    activate,
    deactivate: [],
    parked: stillParked.filter((id) => !activate.includes(id)),
  };
}

/** Groups the shell pins or always shows: an edition never hides them. */
const CORE_GROUPS = new Set(["system", "people"]);

/**
 * Sidebar groups the edition hides by default: every active extension that
 * contributes to the group is for the other audience. A group with even one
 * contributor for this edition (or for both) stays.
 */
export function hiddenNavGroups(mode: EditionMode | null, rows: EditionRow[]): string[] {
  if (!mode) return [];
  const keep = new Set<string>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.status !== "active") continue;
    for (const g of r.navGroups) {
      seen.add(g);
      if (r.audience.includes(mode)) keep.add(g);
    }
  }
  return [...seen].filter((g) => !keep.has(g) && !CORE_GROUPS.has(g)).sort();
}

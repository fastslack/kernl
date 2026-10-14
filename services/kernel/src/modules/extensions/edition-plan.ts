/**
 * Pure decision of what an edition change does to the installed extensions.
 *
 * First apply (a fresh install picking its edition): every free row outside the
 * chosen audience that is active (or installed and not waiting for the user's
 * activation) is parked — disabled, and remembered as disabled
 * BY the edition. Any later change only un-parks: it re-activates rows the
 * edition itself parked that the new audience covers. Nothing the user turned
 * off by hand comes back, and nothing in use is ever turned off.
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
}

export interface EditionPlanInput {
  mode: EditionMode;
  firstApply: boolean;
  rows: EditionRow[];
  parked: string[];
}

export interface EditionPlan {
  activate: string[];
  deactivate: string[];
  /** Ids disabled by the edition after this plan runs. */
  parked: string[];
}

export function planEdition({ mode, firstApply, rows, parked }: EditionPlanInput): EditionPlan {
  if (firstApply) {
    const deactivate = rows
      .filter(
        (r) =>
          !r.paid &&
          !r.audience.includes(mode) &&
          (r.status === "active" || (r.status === "installed" && !r.requiresActivation)),
      )
      .map((r) => r.id);
    return { activate: [], deactivate, parked: deactivate };
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const stillParked = parked.filter((id) => byId.get(id)?.status === "disabled");
  const activate = stillParked.filter((id) => byId.get(id)!.audience.includes(mode));
  return {
    activate,
    deactivate: [],
    parked: stillParked.filter((id) => !activate.includes(id)),
  };
}

import type { BillingCycle } from "./types.js";

import { formatCents } from "../../../../../src/core/formatting.js";
export { formatCents };

/** Advance a date by one billing cycle */
export function advanceBillingDate(isoDate: string, cycle: BillingCycle): string {
  const d = new Date(isoDate + "T00:00:00Z");
  const day = d.getUTCDate();
  switch (cycle) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "quarterly":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case "yearly":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  // Clamp month overflow (e.g. Jan 31 + 1mo → Feb 28)
  if (cycle !== "weekly" && d.getUTCDate() !== day) {
    d.setUTCDate(0);
  }
  return d.toISOString().split("T")[0];
}

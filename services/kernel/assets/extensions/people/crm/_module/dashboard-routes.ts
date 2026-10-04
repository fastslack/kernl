/**
 * HTTP routes for the dashboard's CRM lead pipeline.
 *
 * The legacy `/api/crm/contacts` queries are still served via dashboard
 * channels; this file owns the lead-specific endpoints used by
 * `/crm/leads`.
 */
import { HttpError, type KernelHttpServer } from "@kernl/extension-sdk";
import type { CrmService } from "./service.js";
import type { LeadStatus } from "./types.js";

const LEAD_STATUSES: ReadonlyArray<LeadStatus> = ["", "new", "drafted", "contacted", "qualified", "won", "lost"];

export function registerCrmDashboardRoutes(
  server: KernelHttpServer,
  service: CrmService,
): void {
  // ── GET /api/crm/leads ─────────────────────────────────
  // Query: status (one of LEAD_STATUSES or 'any', default 'any'),
  //        source (free string, optional),
  //        limit (default 200, max 1000).
  server.route("GET", "/api/crm/leads", ({ query }) => {
    const statusRaw = query.get("status") ?? "any";
    const source = query.get("source") ?? "";
    const limit = Math.min(1000, Math.max(1, Number.parseInt(query.get("limit") ?? "200", 10) || 200));

    const status: LeadStatus | "any" = statusRaw === "any" || (LEAD_STATUSES as ReadonlyArray<string>).includes(statusRaw)
      ? (statusRaw as LeadStatus | "any")
      : "any";

    const leads = service.listLeads({ status, source: source || undefined, limit });
    const counts = service.leadCounts(source || undefined);
    return { total: leads.length, counts_by_status: counts, leads };
  });

  // ── POST /api/crm/leads/:id/status ─────────────────────
  // Body: { status: LeadStatus }
  server.route<{ id?: string; status?: string }>("POST", "/api/crm/leads/status", ({ body }) => {
    const id = String(body.id ?? "");
    const status = String(body.status ?? "");
    if (!id) throw new HttpError(400, "Missing 'id'");
    if (!(LEAD_STATUSES as ReadonlyArray<string>).includes(status)) {
      throw new HttpError(400, `Invalid status. Allowed: ${LEAD_STATUSES.join(", ")}`);
    }
    // Any other failure answered 400 with its message, not 500.
    let updated;
    try {
      updated = service.setLeadStatus(id, status as LeadStatus);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    if (!updated) throw new HttpError(404, "Contact not found");
    return updated;
  });

  // ── GET /api/crm/leads/sources ─────────────────────────
  // Convenience: lists distinct lead_source values + counts (for filter UI).
  server.route("GET", "/api/crm/leads/sources", () => {
    // listLeads doesn't expose a "distinct sources" — query directly via service's
    // db handle isn't available. Re-derive in JS over the full lead list (it's
    // bounded — leads table is much smaller than contacts). 1000 is plenty.
    const all = service.listLeads({ status: "any", limit: 1000 });
    const counts: Record<string, number> = {};
    for (const c of all) {
      const k = c.lead_source || "(unknown)";
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const sources = Object.entries(counts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);
    return { sources };
  });
}

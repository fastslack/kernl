/**
 * HTTP routes for the dashboard's CRM lead pipeline.
 *
 * The legacy `/api/crm/contacts` queries are still served via dashboard
 * channels; this file owns the lead-specific endpoints used by
 * `/crm/leads`.
 */
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
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
  server.get("/api/crm/leads", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const statusRaw = url.searchParams.get("status") ?? "any";
    const source = url.searchParams.get("source") ?? "";
    const limit = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200));

    const status: LeadStatus | "any" = statusRaw === "any" || (LEAD_STATUSES as ReadonlyArray<string>).includes(statusRaw)
      ? (statusRaw as LeadStatus | "any")
      : "any";

    const leads = service.listLeads({ status, source: source || undefined, limit });
    const counts = service.leadCounts(source || undefined);
    server.json(res, 200, { total: leads.length, counts_by_status: counts, leads });
  });

  // ── POST /api/crm/leads/:id/status ─────────────────────
  // Body: { status: LeadStatus }
  server.post("/api/crm/leads/status", async (req, res) => {
    try {
      const body = await server.parseBody<{ id?: string; status?: string }>(req);
      const id = String(body.id ?? "");
      const status = String(body.status ?? "");
      if (!id) { server.json(res, 400, { error: "Missing 'id'" }); return; }
      if (!(LEAD_STATUSES as ReadonlyArray<string>).includes(status)) {
        server.json(res, 400, { error: `Invalid status. Allowed: ${LEAD_STATUSES.join(", ")}` });
        return;
      }
      const updated = service.setLeadStatus(id, status as LeadStatus);
      if (!updated) { server.json(res, 404, { error: "Contact not found" }); return; }
      server.json(res, 200, updated);
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /api/crm/leads/sources ─────────────────────────
  // Convenience: lists distinct lead_source values + counts (for filter UI).
  server.get("/api/crm/leads/sources", (_req, res) => {
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
    server.json(res, 200, { sources });
  });
}

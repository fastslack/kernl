// tests/panels-module.test.ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { panelsMigrations } from "../src/modules/panels/migrations.js";
import { PanelStore } from "../src/modules/panels/store.js";
import { PanelGateway } from "../src/modules/panels/gateway.js";
import { registerPanelsRoutes } from "../src/modules/panels/api-routes.js";
import { panelTools } from "../src/modules/panels/tools.js";

type Handler = (req: { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> }) => unknown;

function fakeServer() {
  const routes = new Map<string, Handler>();
  return { routes, route: (m: string, p: string, h: Handler) => { routes.set(`${m} ${p}`, h); } };
}

describe("panels module surface", () => {
  const db = new Database(":memory:");
  runMigrations(db, "panels", panelsMigrations);
  const store = new PanelStore(db);
  store.saveSpec("f1", { version: 1, sources: { n: { type: "collection", name: "notes" } },
    views: [{ id: "notes", title: "Notas", component: "table", data: "n:$" }] }, "");
  const gw = new PanelGateway(store, { agentInOffice: () => null, postLetter: () => ({ ok: true }), startRun: () => ({ runId: "r" }), setSchedulesActive: () => 0 });

  it("serves spec, source, action errors and audit through the routes", async () => {
    const s = fakeServer();
    registerPanelsRoutes(s as never, gw, store);
    const q = new URLSearchParams();
    expect(await s.routes.get("GET /api/panels/:flowId")!({ params: { flowId: "f1" }, query: q, body: {} })).toMatchObject({ spec: { version: 1 } });
    expect(await s.routes.get("GET /api/panels/:flowId/sources/:source")!({ params: { flowId: "f1", source: "n" }, query: q, body: {} })).toMatchObject({ data: {} });
    await expect(Promise.resolve().then(() => s.routes.get("POST /api/panels/:flowId/actions/:action")!({ params: { flowId: "f1", action: "ghost" }, query: q, body: { values: {} } })))
      .rejects.toMatchObject({ status: 403 });
    expect(await s.routes.get("GET /api/panels/:flowId/audit")!({ params: { flowId: "f1" }, query: q, body: {} })).toMatchObject({ items: [{ action: "ghost", ok: false }] });
  });

  it("lets an agent write only to its own office's collections", async () => {
    let owner: string | null = "f1";
    const tools = new Map(panelTools(store, () => owner).map((t) => [t.name, t]));
    await tools.get("kernel_panel_record_append")!.handler({ collection: "events", data: { text: "despachado web#1" } });
    expect(store.listRecords("f1", "events")[0].data).toEqual({ text: "despachado web#1" });
    owner = null;
    const r = await tools.get("kernel_panel_record_put")!.handler({ collection: "events", key: "k", data: {} }) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });
});

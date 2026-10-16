// tests/panels-gateway.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { panelsMigrations } from "../src/modules/panels/migrations.js";
import { PanelStore } from "../src/modules/panels/store.js";
import { PanelGateway, PanelError } from "../src/modules/panels/gateway.js";
import { parsePanelSpec } from "../src/modules/panels/spec.js";

const raw = {
  version: 1,
  sources: { ledger: { type: "state-file", path: "ledger.json" }, notes: { type: "collection", name: "notes" } },
  views: [{ id: "issues", title: "Issues", component: "table", data: "ledger:$.issues" }],
  actions: {
    "vigia.mode": { type: "letter", label: "Mandar", to: "heural-vigia",
      subject: { by: "mode", cases: { uno: "TOMAR {{issue}}", ronda: "RONDA" } },
      body: "Pedido desde el panel.",
      input: { type: "object", required: ["mode", "issue"], properties: {
        mode: { type: "string", enum: ["uno", "ronda"] },
        issue: { type: "string", pattern: "^(api|web)#\\d+$", visibleIf: { mode: "uno" } } } } },
    ronda: { type: "run", label: "Ronda", agent: "heural-vigia", goal: "Ronda del vigía." },
    nota: { type: "record", label: "Nota", collection: "notes", key: "{{key}}",
      input: { type: "object", required: ["key", "text"], properties: { key: { type: "string" }, text: { type: "string", maxLength: 500 } } } },
    continuo: { type: "schedule", label: "Continuo", agent: "heural-vigia", state: "on" },
  },
};

describe("PanelGateway", () => {
  let store: PanelStore;
  let gw: PanelGateway;
  let clock = 1_000_000;
  const letters: Array<{ toAgentId: string; subject: string; body: string }> = [];
  const runs: string[] = [];
  const schedules: Array<[string, boolean]> = [];
  beforeEach(() => {
    letters.length = 0; runs.length = 0; schedules.length = 0; clock = 1_000_000;
    const root = mkdtempSync(join(tmpdir(), "gw-"));
    writeFileSync(join(root, "ledger.json"), JSON.stringify({ issues: { "web#1": { state: "ready" } } }));
    const db = new Database(":memory:");
    runMigrations(db, "panels", panelsMigrations);
    store = new PanelStore(db);
    const parsed = parsePanelSpec(raw, { agentSlugs: ["heural-vigia"] });
    if (!parsed.ok) throw new Error(parsed.error);
    store.saveSpec("f1", parsed.spec, root);
    gw = new PanelGateway(store, {
      agentInOffice: (flowId, slug) => (flowId === "f1" && slug === "heural-vigia" ? { id: "vigia-id", name: "Heural Vigía", active: true } : null),
      postLetter: (l) => { letters.push(l); return { ok: true }; },
      startRun: ({ agentId }) => { runs.push(agentId); return { runId: "run-1" }; },
      setSchedulesActive: (agentId, active) => { schedules.push([agentId, active]); return 1; },
      now: () => clock,
    });
  });

  it("reads a declared source with a selector and answers unchanged on the same version", async () => {
    const a = await gw.read("f1", "ledger", { select: "$.issues" });
    expect(a.data).toEqual({ "web#1": { state: "ready" } });
    expect(await gw.read("f1", "ledger", { since: a.version })).toEqual({ version: a.version, unchanged: true });
  });

  it("refuses undeclared sources and actions with 403, and audits the attempt", async () => {
    await expect(gw.read("f1", "ghost")).rejects.toThrow(PanelError);
    try { gw.act("f1", "merge.everything", {}, "operator"); } catch (e) { expect((e as PanelError).status).toBe(403); }
    expect(store.listAudit("f1")[0]).toMatchObject({ action: "merge.everything", ok: false });
    await expect(gw.read("other-office", "ledger")).rejects.toThrow(PanelError);
  });

  it("sends a letter built from the case template, after validating the form", () => {
    expect(gw.act("f1", "vigia.mode", { mode: "uno", issue: "web#2585" }, "operator")).toEqual({ ok: true, result: expect.stringContaining("Heural Vigía") });
    expect(letters[0]).toMatchObject({ toAgentId: "vigia-id", subject: "TOMAR web#2585" });
    expect(letters[0].body).toContain("Pedido desde el panel.");
    expect(store.listAudit("f1")[0]).toMatchObject({ action: "vigia.mode", ok: true, values: { mode: "uno", issue: "web#2585" } });
  });

  it("rejects bad input with 400 and sends nothing", () => {
    try { gw.act("f1", "vigia.mode", { mode: "uno", issue: "mobile#1" }, "operator"); throw new Error("no"); }
    catch (e) { expect((e as PanelError).status).toBe(400); }
    expect(letters.length).toBe(0);
    expect(store.listAudit("f1")[0]).toMatchObject({ ok: false });
  });

  it("rate-limits a double click with 429", () => {
    gw.act("f1", "ronda", {}, "operator");
    clock += 1000;
    try { gw.act("f1", "ronda", {}, "operator"); throw new Error("no"); }
    catch (e) { expect((e as PanelError).status).toBe(429); }
    clock += 3000;
    gw.act("f1", "ronda", {}, "operator");
    expect(runs).toEqual(["vigia-id", "vigia-id"]);
  });

  it("writes a record and switches schedules on", () => {
    gw.act("f1", "nota", { key: "web#1", text: "revisar" }, "operator");
    expect(store.listRecords("f1", "notes")[0]).toMatchObject({ key: "web#1", data: { key: "web#1", text: "revisar" } });
    gw.act("f1", "continuo", {}, "operator");
    expect(schedules).toEqual([["vigia-id", true]]);
  });

  it("refuses an action whose agent left the office (409)", () => {
    const gw2 = new PanelGateway(store, { agentInOffice: () => null, postLetter: () => ({ ok: true }), startRun: () => ({ runId: "x" }), setSchedulesActive: () => 0 });
    try { gw2.act("f1", "ronda", {}, "operator"); throw new Error("no"); }
    catch (e) { expect((e as PanelError).status).toBe(409); }
  });

  describe("channel sources", () => {
    const channelSpec = {
      version: 1,
      sources: { pipeline: { type: "channel", name: "salesPanel", params: { project: "heural" } }, ghost: { type: "channel", name: "nope" } },
      views: [{ id: "deals", title: "Deals", component: "board", data: "pipeline:$.deals", columns: "stage" }],
    };
    const calls: Array<[string, Record<string, string>]> = [];
    let payload: unknown = { deals: { d1: { stage: "new" } } };
    const gwWith = (readChannel?: (n: string, p: Record<string, string>) => Promise<unknown>) => {
      const parsed = parsePanelSpec(channelSpec, { agentSlugs: [] });
      if (!parsed.ok) throw new Error(parsed.error);
      store.saveSpec("f2", parsed.spec, "");
      return new PanelGateway(store, {
        agentInOffice: () => null, postLetter: () => ({ ok: true }), startRun: () => ({ runId: "r" }), setSchedulesActive: () => 0,
        readChannel,
      });
    };
    beforeEach(() => { calls.length = 0; payload = { deals: { d1: { stage: "new" } } }; });
    const reader = async (n: string, p: Record<string, string>) => { calls.push([n, p]); return n === "salesPanel" ? payload : undefined; };

    it("reads the module channel with the declared params, without an office folder", async () => {
      const g = gwWith(reader);
      const a = await g.read("f2", "pipeline", { select: "$.deals" });
      expect(a.data).toEqual({ d1: { stage: "new" } });
      expect(calls).toEqual([["salesPanel", { project: "heural" }]]);
      expect(await g.read("f2", "pipeline", { since: a.version })).toEqual({ version: a.version, unchanged: true });
      payload = { deals: { d1: { stage: "contacted" } } };
      expect((await g.read("f2", "pipeline", { since: a.version })).version).not.toBe(a.version);
    });

    it("answers 404 for a channel no module registers and 503 without a reader", async () => {
      await expect(gwWith(reader).read("f2", "ghost")).rejects.toMatchObject({ status: 404 });
      await expect(gwWith(undefined).read("f2", "pipeline")).rejects.toMatchObject({ status: 503 });
    });

    it("refuses a channel answer over the size cap with 413", async () => {
      payload = { blob: "x".repeat(1_100_000) };
      await expect(gwWith(reader).read("f2", "pipeline")).rejects.toMatchObject({ status: 413 });
    });
  });
});

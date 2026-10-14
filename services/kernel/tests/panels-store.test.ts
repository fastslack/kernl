// tests/panels-store.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { panelsMigrations } from "../src/modules/panels/migrations.js";
import { PanelStore } from "../src/modules/panels/store.js";

const spec = { version: 1 as const, sources: { n: { type: "collection" as const, name: "notes" } },
  views: [{ id: "notes", title: "Notas", component: "table" as const, data: "n:$" }] };

describe("PanelStore", () => {
  let store: PanelStore;
  beforeEach(() => {
    const db = new Database(":memory:");
    runMigrations(db, "panels", panelsMigrations);
    store = new PanelStore(db);
  });

  it("saves, replaces and deletes an office spec", () => {
    expect(store.getSpec("f1")).toBeNull();
    store.saveSpec("f1", spec, "/office");
    expect(store.getSpec("f1")?.rootDir).toBe("/office");
    store.saveSpec("f1", { ...spec, views: [{ ...spec.views[0], title: "Otra" }] }, "/office2");
    expect(store.getSpec("f1")?.spec.views[0].title).toBe("Otra");
    store.deleteSpec("f1");
    expect(store.getSpec("f1")).toBeNull();
  });

  it("keeps records per owner and collection, newest first, and moves the version", () => {
    const v0 = store.collectionVersion("f1", "notes");
    store.putRecord("f1", "notes", "a", { t: 1 }, "agent-1");
    store.putRecord("f1", "notes", "a", { t: 2 }, "agent-1");
    const k = store.appendRecord("f1", "notes", { t: 3 }, "agent-2");
    store.putRecord("f2", "notes", "z", { t: 9 }, "agent-9");
    const rows = store.listRecords("f1", "notes");
    expect(rows.map((r) => r.key)).toEqual([k, "a"]);
    expect(rows[1].data).toEqual({ t: 2 });
    expect(store.collectionVersion("f1", "notes")).not.toBe(v0);
  });

  it("writes and lists the audit trail", () => {
    store.audit({ owner: "f1", action: "vigia.mode", values: { mode: "uno" }, ok: true, result: "sent", actor: "operator" });
    store.audit({ owner: "f1", action: "x", values: {}, ok: false, result: "403", actor: "operator" });
    const a = store.listAudit("f1");
    expect(a.length).toBe(2);
    expect(a[0].action).toBe("x");
    expect(a[1].values).toEqual({ mode: "uno" });
  });
});

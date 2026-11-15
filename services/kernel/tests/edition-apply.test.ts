import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { applyEdition, editionStatus, type ExtensionsPort } from "../src/modules/extensions/edition-apply.js";
import { readEditionState, writeEditionState } from "../src/core/edition.js";
import type { InstalledExtension, ExtensionStatus } from "../src/modules/extensions/types.js";

function fakeExt(defs: Array<{ id: string; status: ExtensionStatus; audience?: string[]; paid?: boolean; nav?: string[] }>) {
  const rows = new Map(defs.map((d) => [d.id, { ...d }]));
  const port: ExtensionsPort = {
    list: () =>
      [...rows.values()].map((d) => ({
        id: d.id, slug: d.id, name: d.id, version: "1.0.0", type: "module", status: d.status,
        manifest_json: JSON.stringify({
          audience: d.audience,
          pricing: d.paid ? { model: "one-time", amount_cents: 100, currency: "USD" } : undefined,
          frontend: d.nav ? { navItems: d.nav.map((group) => ({ id: `${d.id}-${group}`, group })) } : undefined,
        }),
      })) as unknown as InstalledExtension[],
    enable: async (id: string) => { rows.get(id)!.status = "active"; },
    disable: async (id: string) => { rows.get(id)!.status = "disabled"; },
  };
  return { port, rows };
}

function db(): Database {
  const d = new Database(":memory:");
  runMigrations(d, "extensions", extensionsMigrations);
  return d;
}

describe("applyEdition", () => {
  it("first apply on a fresh install turns nothing off and hides the other audience's menus", async () => {
    const d = db();
    const { port, rows } = fakeExt([
      { id: "crm", status: "active", audience: ["business"], nav: ["sales"] },
      { id: "home", status: "active", audience: ["personal"], nav: ["dashboard"] },
      { id: "tasks", status: "active", nav: ["work"] },
    ]);
    const s = await applyEdition(d, port, "business");
    expect(s.deactivated).toEqual([]);
    expect(rows.get("home")!.status).toBe("active");
    expect(s.hiddenGroups).toEqual(["dashboard"]);
    expect(readEditionState(d)).toEqual({ mode: "business", legacy: false, parked: [] });
    expect(editionStatus(d, port).hiddenGroups).toEqual(["dashboard"]);
  });

  it("a second apply (setup re-run in another browser) never deactivates", async () => {
    const d = db();
    writeEditionState(d, { mode: "personal", parked: [] });
    const { port, rows } = fakeExt([{ id: "home", status: "active", audience: ["personal"] }]);
    const s = await applyEdition(d, port, "business");
    expect(s.deactivated).toEqual([]);
    expect(rows.get("home")!.status).toBe("active");
    expect(readEditionState(d).mode).toBe("business");
  });

  it("a legacy install never deactivates, even on its first choice", async () => {
    const d = db();
    d.prepare("INSERT INTO edition_state (key, value) VALUES ('legacy', '1')").run();
    const { port, rows } = fakeExt([{ id: "home", status: "active", audience: ["personal"] }]);
    const s = await applyEdition(d, port, "business");
    expect(s.deactivated).toEqual([]);
    expect(rows.get("home")!.status).toBe("active");
  });

  it("addOnly on a fresh install deactivates nothing and saves the mode", async () => {
    const d = db();
    const { port, rows } = fakeExt([{ id: "home", status: "active", audience: ["personal"] }]);
    const s = await applyEdition(d, port, "business", { addOnly: true });
    expect(s.deactivated).toEqual([]);
    expect(rows.get("home")!.status).toBe("active");
    expect(readEditionState(d)).toEqual({ mode: "business", legacy: false, parked: [] });
  });

  it("switching back re-activates what an older edition parked", async () => {
    const d = db();
    writeEditionState(d, { mode: "business", parked: ["home"] });
    const { port, rows } = fakeExt([{ id: "home", status: "disabled", audience: ["personal"] }]);
    const s = await applyEdition(d, port, "personal");
    expect(s.activated).toEqual(["home"]);
    expect(rows.get("home")!.status).toBe("active");
    expect(readEditionState(d).parked).toEqual([]);
  });

  it("one failing enable is reported, not fatal, and stays parked", async () => {
    const d = db();
    writeEditionState(d, { mode: "business", parked: ["home"] });
    const { port } = fakeExt([{ id: "home", status: "disabled", audience: ["personal"] }]);
    port.enable = async () => { throw new Error("missing package"); };
    const s = await applyEdition(d, port, "personal");
    expect(s.failed).toEqual([{ id: "home", error: "missing package" }]);
    expect(readEditionState(d).parked).toEqual(["home"]);
  });
});

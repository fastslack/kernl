import { describe, it, expect } from "bun:test";
import { hiddenNavGroups, planEdition, type EditionRow } from "../src/modules/extensions/edition-plan.js";
import { audienceOf } from "../src/core/edition.js";

const BOTH = ["personal", "business"] as const;
const row = (id: string, audience: readonly ("personal" | "business")[], status: EditionRow["status"] = "active", navGroups: string[] = []): EditionRow =>
  ({ id, status, audience: [...audience], paid: false, requiresActivation: false, navGroups });

describe("audienceOf", () => {
  it("treats missing or empty as both", () => {
    expect(audienceOf(undefined)).toEqual(["personal", "business"]);
    expect(audienceOf({})).toEqual(["personal", "business"]);
    expect(audienceOf({ audience: [] })).toEqual(["personal", "business"]);
    expect(audienceOf({ audience: ["business"] })).toEqual(["business"]);
  });
});

describe("planEdition", () => {
  it("a fresh choice deactivates nothing", () => {
    const rows = [row("crm", ["business"]), row("home", ["personal"]), row("tasks", BOTH)];
    for (const mode of ["personal", "business"] as const) {
      expect(planEdition({ mode, rows, parked: [] })).toEqual({ activate: [], deactivate: [], parked: [] });
    }
  });

  it("re-activates only what an older edition parked, and deactivates nothing", () => {
    const rows = [
      row("crm", ["business"], "disabled"),        // parked by edition
      row("slack", ["business"], "disabled"),      // disabled by the user
      row("home", ["personal"], "active"),
    ];
    const p = planEdition({ mode: "business", rows, parked: ["crm"] });
    expect(p.activate).toEqual(["crm"]);
    expect(p.deactivate).toEqual([]);
    expect(p.parked).toEqual([]);
  });

  it("keeps parked ids that the new mode does not cover", () => {
    const rows = [row("home", ["personal"], "disabled")];
    const p = planEdition({ mode: "business", rows, parked: ["home"] });
    expect(p.activate).toEqual([]);
    expect(p.parked).toEqual(["home"]);
  });

  it("drops parked ids whose row is gone or no longer disabled", () => {
    const rows = [row("home", ["personal"], "active")];
    const p = planEdition({ mode: "personal", rows, parked: ["home", "uninstalled"] });
    expect(p.activate).toEqual([]);
    expect(p.parked).toEqual([]);
  });
});

describe("hiddenNavGroups", () => {
  const rows = [
    row("home", ["personal"], "active", ["dashboard"]),
    row("leisure", ["personal"], "active", ["leisure"]),
    row("repos", ["business"], "active", ["tools"]),
    row("work", BOTH, "active", ["work"]),
    row("life", ["personal"], "active", ["work"]),
    row("people", ["personal"], "active", ["people"]),
  ];

  it("hides the groups that only the other audience fills", () => {
    expect(hiddenNavGroups("business", rows)).toEqual(["dashboard", "leisure"]);
    expect(hiddenNavGroups("personal", rows)).toEqual(["tools"]);
  });

  it("keeps a group with one contributor for this edition, and never hides people or system", () => {
    expect(hiddenNavGroups("business", rows)).not.toContain("work");
    expect(hiddenNavGroups("business", rows)).not.toContain("people");
  });

  it("ignores inactive extensions and hides nothing without an edition", () => {
    const off = [row("crm", ["business"], "disabled", ["sales"]), row("home", ["personal"], "active", ["sales"])];
    expect(hiddenNavGroups("business", off)).toEqual(["sales"]);
    expect(hiddenNavGroups(null, rows)).toEqual([]);
  });
});

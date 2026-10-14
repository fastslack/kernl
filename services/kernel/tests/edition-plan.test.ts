import { describe, it, expect } from "bun:test";
import { planEdition, type EditionRow } from "../src/modules/extensions/edition-plan.js";
import { audienceOf } from "../src/core/edition.js";

const BOTH = ["personal", "business"] as const;
const row = (id: string, audience: readonly ("personal" | "business")[], status: EditionRow["status"] = "active", paid = false, requiresActivation = false): EditionRow =>
  ({ id, status, audience: [...audience], paid, requiresActivation });

describe("audienceOf", () => {
  it("treats missing or empty as both", () => {
    expect(audienceOf(undefined)).toEqual(["personal", "business"]);
    expect(audienceOf({})).toEqual(["personal", "business"]);
    expect(audienceOf({ audience: [] })).toEqual(["personal", "business"]);
    expect(audienceOf({ audience: ["business"] })).toEqual(["business"]);
  });
});

describe("planEdition — first apply", () => {
  const rows = [
    row("crm", ["business"]),
    row("home", ["personal"]),
    row("tasks", BOTH),
  ];

  it("business: parks personal-only, keeps business and both", () => {
    const p = planEdition({ mode: "business", firstApply: true, rows, parked: [] });
    expect(p.deactivate).toEqual(["home"]);
    expect(p.activate).toEqual([]);
    expect(p.parked).toEqual(["home"]);
  });

  it("personal: parks business-only", () => {
    const p = planEdition({ mode: "personal", firstApply: true, rows, parked: [] });
    expect(p.deactivate).toEqual(["crm"]);
    expect(p.parked).toEqual(["crm"]);
  });

  it("never deactivates a paid extension", () => {
    const p = planEdition({ mode: "personal", firstApply: true, rows: [row("books", ["business"], "active", true)], parked: [] });
    expect(p.deactivate).toEqual([]);
  });

  it("never touches error rows", () => {
    const p = planEdition({
      mode: "personal", firstApply: true,
      rows: [row("b", ["business"], "error")],
      parked: [],
    });
    expect(p.deactivate).toEqual([]);
  });

  it("parks an installed free out-of-audience row, unless it requires activation", () => {
    const p = planEdition({
      mode: "personal", firstApply: true,
      rows: [
        row("a", ["business"], "installed"),
        row("b", ["business"], "installed", false, true),
        row("c", ["business"], "installed", true),
      ],
      parked: [],
    });
    expect(p.deactivate).toEqual(["a"]);
    expect(p.parked).toEqual(["a"]);
  });
});

describe("planEdition — later switch", () => {
  it("re-activates only what the edition parked, and deactivates nothing", () => {
    const rows = [
      row("crm", ["business"], "disabled"),        // parked by edition
      row("slack", ["business"], "disabled"),      // disabled by the user
      row("home", ["personal"], "active"),
    ];
    const p = planEdition({ mode: "business", firstApply: false, rows, parked: ["crm"] });
    expect(p.activate).toEqual(["crm"]);
    expect(p.deactivate).toEqual([]);
    expect(p.parked).toEqual([]);
  });

  it("keeps parked ids that the new mode does not cover", () => {
    const rows = [row("home", ["personal"], "disabled")];
    const p = planEdition({ mode: "business", firstApply: false, rows, parked: ["home"] });
    expect(p.activate).toEqual([]);
    expect(p.parked).toEqual(["home"]);
  });

  it("drops parked ids whose row is gone or no longer disabled", () => {
    const rows = [row("home", ["personal"], "active")];
    const p = planEdition({ mode: "personal", firstApply: false, rows, parked: ["home", "uninstalled"] });
    expect(p.activate).toEqual([]);
    expect(p.parked).toEqual([]);
  });
});

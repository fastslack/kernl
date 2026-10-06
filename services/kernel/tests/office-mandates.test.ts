/** Generated mandates for agents founded without a hand-written prompt. */
import { describe, it, expect } from "bun:test";
import { expandMandates } from "../src/modules/agents/office-mandates.js";
import { officeDefinitionFromJson } from "../src/modules/agents/office-kit.js";

const long = (who: string) => `## Role\nYou are ${who}. ` + "You find and close new customers. ".repeat(12);

function office() {
  return officeDefinitionFromJson({
    name: "Heural",
    description: "Ventas y crecimiento",
    agents: [
      { name: "Heural Tech Lead", role: "manager", prompt: "Custom prompt the operator wrote.", chainTo: ["Heural Ventas"] },
      { name: "Heural Ventas", description: "Busca, convence y atrae nuevos clientes e inversores", prompt: "You are Heural Ventas. Busca, convence y atrae nuevos clientes e inversores" },
    ],
  });
}

describe("expandMandates", () => {
  it("replaces only the named agents and tells the model about the whole team", async () => {
    const def = office();
    let seen = { system: "", user: "" };
    const n = await expandMandates(def, ["heural ventas"], "es", async (opts) => {
      seen = { system: opts.system ?? "", user: String(opts.user ?? "") };
      return { mandates: [{ name: "Heural Ventas", mandate: long("Heural Ventas") }] };
    });
    expect(n).toBe(1);
    expect(def.agents[1].prompt).toStartWith("## Role");
    expect(def.agents[0].prompt).toBe("Custom prompt the operator wrote.");
    expect(seen.user).toContain("Heural Tech Lead (lead");
    expect(seen.user).toContain("Busca, convence y atrae");
    expect(seen.user).toContain("Write mandates for: Heural Ventas");
    expect(seen.system).toContain("Spanish");
  });

  it("keeps the fallback when the mandate is too short or names nobody", async () => {
    const def = office();
    const before = def.agents[1].prompt;
    const n = await expandMandates(def, ["Heural Ventas"], "en", async () => ({
      mandates: [{ name: "Heural Ventas", mandate: "too short" }, { name: "Ghost", mandate: long("Ghost") }],
    }));
    expect(n).toBe(0);
    expect(def.agents[1].prompt).toBe(before);
  });

  it("throws on a reply without mandates, so the caller keeps the fallback", async () => {
    await expect(expandMandates(office(), ["Heural Ventas"], "en", async () => ({ nope: 1 }))).rejects.toThrow();
  });

  it("does not call the model when nobody needs a mandate", async () => {
    let called = false;
    const n = await expandMandates(office(), [], "en", async () => { called = true; return {}; });
    expect(n).toBe(0);
    expect(called).toBe(false);
  });
});

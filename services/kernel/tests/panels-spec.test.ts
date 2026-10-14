// tests/panels-spec.test.ts
import { describe, it, expect } from "bun:test";
import { parsePanelSpec } from "../src/modules/panels/spec.js";

const base = {
  version: 1,
  sources: { ledger: { type: "state-file", path: "ledger.json" }, events: { type: "collection", name: "events" } },
  views: [
    { id: "issues", title: { es: "Issues" }, component: "board", data: "ledger:$.issues", columns: "state", detail: "issue" },
    { id: "issue", title: "Issue", component: "detail", data: "ledger:$.issues[{{key}}]", actions: ["nota"] },
    { id: "vigia", title: "Vigía", component: "form", action: "vigia.mode" },
    { id: "flujo", title: "Flujo", component: "timeline", data: "events:$", time: "at", text: "{{text}}" },
  ],
  anchors: [{ object: "wall-board", view: "issues" }],
  actions: {
    "vigia.mode": { type: "letter", label: "Mandar", to: "heural-vigia",
      subject: { by: "mode", cases: { uno: "TOMAR {{issue}}", ronda: "RONDA" } },
      input: { type: "object", required: ["mode"], properties: { mode: { type: "string", enum: ["uno", "ronda"] }, issue: { type: "string", visibleIf: { mode: "uno" } } } },
      confirm: { es: "¿Mandar?" } },
    nota: { type: "record", label: "Nota", collection: "notes", key: "{{key}}" },
    continuo: { type: "schedule", label: "Continuo", agent: "heural-vigia", state: "on" },
    ronda: { type: "run", label: "Ronda", agent: "heural-vigia", goal: "Ronda del vigía." },
  },
};
const ctx = { agentSlugs: ["heural-vigia", "heural-integrador"] };

describe("parsePanelSpec", () => {
  it("accepts a complete v1 spec", () => {
    const r = parsePanelSpec(base, ctx);
    expect(r.ok).toBe(true);
  });
  it("rejects an unknown component, version and source type", () => {
    expect(parsePanelSpec({ ...base, version: 2 }, ctx).ok).toBe(false);
    expect(parsePanelSpec({ ...base, views: [{ ...base.views[0], component: "iframe" }] }, ctx).ok).toBe(false);
    expect(parsePanelSpec({ ...base, sources: { x: { type: "http", url: "http://a" } } }, ctx).ok).toBe(false);
  });
  it("rejects broken references with the exact reason", () => {
    const badSource = parsePanelSpec({ ...base, views: [{ ...base.views[0], data: "nope:$" }] }, ctx);
    expect(badSource).toEqual({ ok: false, error: expect.stringContaining('unknown source "nope"') });
    const badDetail = parsePanelSpec({ ...base, views: [{ ...base.views[0], detail: "ghost" }] }, ctx);
    expect(badDetail.ok ? "" : badDetail.error).toContain('unknown view "ghost"');
    const badAction = parsePanelSpec({ ...base, views: [{ ...base.views[1], actions: ["ghost"] }] }, ctx);
    expect(badAction.ok ? "" : badAction.error).toContain('unknown action "ghost"');
    const badAgent = parsePanelSpec({ ...base, actions: { ...base.actions, ronda: { type: "run", label: "R", agent: "other-office-agent", goal: "x" } } }, ctx);
    expect(badAgent.ok ? "" : badAgent.error).toContain('agent "other-office-agent" is not in this office');
    const badAnchor = parsePanelSpec({ ...base, anchors: [{ object: "x", view: "ghost" }] }, ctx);
    expect(badAnchor.ok).toBe(false);
  });
  it("rejects state-file paths that leave the office folder", () => {
    for (const path of ["../x.json", "/etc/passwd", "a/../../b.json"]) {
      expect(parsePanelSpec({ ...base, sources: { ledger: { type: "state-file", path } } }, ctx).ok).toBe(false);
    }
  });
  it("rejects a case template whose field is not in the input", () => {
    const r = parsePanelSpec({ ...base, actions: { ...base.actions, "vigia.mode": { ...base.actions["vigia.mode"], subject: { by: "ghost", cases: { a: "x" } } } } }, ctx);
    expect(r.ok ? "" : r.error).toContain('"ghost" is not an input field');
  });
});

describe("parsePanelSpec patterns", () => {
  it("rejects a pattern that does not compile", () => {
    const bad = { ...base, actions: { ...base.actions, "vigia.mode": { ...base.actions["vigia.mode"],
      input: { type: "object", properties: { mode: { type: "string", pattern: "([" } } } } } };
    const r = parsePanelSpec(bad, ctx);
    expect(r.ok ? "" : r.error).toContain("pattern");
  });
});

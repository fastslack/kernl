// src/lib/panels/form-model.test.ts
import { describe, it, expect } from "bun:test";
import { formFields, isVisible } from "./form-model.js";

describe("formFields", () => {
  const schema = { type: "object" as const, required: ["mode"], properties: {
    mode: { type: "string" as const, enum: ["uno", "ronda"], title: { es: "Modo" } },
    issue: { type: "string" as const, visibleIf: { mode: "uno" }, pattern: "^web#\\d+$" },
    nota: { type: "string" as const, maxLength: 800 },
    ok: { type: "boolean" as const },
    n: { type: "integer" as const },
  } };
  it("maps each property to a control", () => {
    const f = formFields(schema, "es");
    expect(f.map((x) => [x.key, x.kind])).toEqual([["mode", "select"], ["issue", "text"], ["nota", "textarea"], ["ok", "checkbox"], ["n", "number"]]);
    expect(f[0]).toMatchObject({ label: "Modo", required: true, options: ["uno", "ronda"] });
  });
  it("hides fields until their condition holds", () => {
    const issue = formFields(schema, "es")[1];
    expect(isVisible(issue, { mode: "ronda" })).toBe(false);
    expect(isVisible(issue, { mode: "uno" })).toBe(true);
  });
});

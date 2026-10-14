// tests/panels-utils.test.ts
import { describe, it, expect } from "bun:test";
import { validateLite, coerceFormValues, stripSecrets } from "../src/modules/panels/jsonschema-lite.js";
import { renderTemplate, TemplateError } from "../src/modules/panels/template.js";
import { selectPath, SelectorError } from "../src/modules/panels/select.js";

describe("validateLite", () => {
  const s = { type: "object" as const, required: ["mode"], properties: {
    mode: { type: "string" as const, enum: ["uno", "ronda"] },
    issue: { type: "string" as const, pattern: "^(api|web)#\\d+$" },
    n: { type: "integer" as const, minimum: 1, maximum: 9 },
  } };
  it("accepts a valid object", () => {
    expect(validateLite(s, { mode: "uno", issue: "web#12", n: 3 })).toEqual([]);
  });
  it("reports each problem with its path", () => {
    const errs = validateLite(s, { mode: "x", issue: "mobile#1", n: 0 });
    expect(errs.join("|")).toContain("mode");
    expect(errs.join("|")).toContain("issue");
    expect(errs.join("|")).toContain("n");
    expect(validateLite(s, {})).toEqual(["mode: required"]);
  });
  it("walks arrays and nested objects", () => {
    expect(validateLite({ type: "array", items: { type: "object", required: ["k"] } }, [{ k: 1 }, {}])).toEqual(["[1].k: required"]);
  });
});

describe("coerceFormValues", () => {
  const s = { type: "object" as const, required: ["mode", "issue"], properties: {
    mode: { type: "string" as const, enum: ["uno", "ronda"] },
    issue: { type: "string" as const, visibleIf: { mode: "uno" } },
    n: { type: "number" as const },
  } };
  it("converts numbers, drops unknown and hidden fields", () => {
    const r = coerceFormValues(s, { mode: "ronda", issue: "web#1", n: "4", evil: "x" });
    expect(r.errors).toEqual([]);
    expect(r.values).toEqual({ mode: "ronda", n: 4 });
  });
  it("requires a visible required field", () => {
    expect(coerceFormValues(s, { mode: "uno" }).errors).toEqual(["issue: required"]);
  });
});

describe("stripSecrets", () => {
  it("removes fields marked secret", () => {
    const s = { type: "object" as const, properties: { a: { type: "string" as const }, t: { type: "string" as const, secret: true } } };
    expect(stripSecrets(s, { a: "1", t: "x" })).toEqual({ a: "1" });
  });
});

describe("renderTemplate", () => {
  it("interpolates fields and dotted paths, missing as empty", () => {
    expect(renderTemplate("TOMAR {{issue}} {{a.b}}{{nope}}", { issue: "web#1", a: { b: "!" } })).toBe("TOMAR web#1 !");
  });
  it("picks a case by a field", () => {
    const t = { by: "mode", cases: { uno: "TOMAR {{issue}}", ronda: "RONDA" } };
    expect(renderTemplate(t, { mode: "uno", issue: "api#2" })).toBe("TOMAR api#2");
    expect(renderTemplate(t, { mode: "ronda" })).toBe("RONDA");
    expect(() => renderTemplate(t, { mode: "x" })).toThrow(TemplateError);
  });
  it("never evaluates code", () => {
    expect(renderTemplate("{{constructor}}{{__proto__}}", {})).toBe("");
  });
});

describe("selectPath", () => {
  const data = { issues: { "web#1": { state: "ready" } }, list: [1, 2] };
  it("selects root, dotted and bracket keys", () => {
    expect(selectPath(data, "$")).toBe(data);
    expect(selectPath(data, "$.list")).toEqual([1, 2]);
    expect(selectPath(data, "$.issues[web#1].state")).toBe("ready");
    expect(selectPath(data, "$.issues[{{key}}]", { key: "web#1" })).toEqual({ state: "ready" });
    expect(selectPath(data, "$.nope.deeper")).toBeUndefined();
  });
  it("rejects selectors that are not paths", () => {
    expect(() => selectPath(data, "issues")).toThrow(SelectorError);
    expect(() => selectPath(data, "$..x")).toThrow(SelectorError);
    expect(() => selectPath(data, "$.__proto__")).toThrow(SelectorError);
  });
});

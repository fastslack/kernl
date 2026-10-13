// src/lib/panels/template.test.ts
import { describe, it, expect } from "bun:test";
import { renderText, textOf } from "./template.js";

describe("renderText", () => {
  it("interpolates as plain text and ignores prototype keys", () => {
    expect(renderText("{{key}} · {{title}}", { key: "web#1", title: "<b>x</b>" })).toBe("web#1 · <b>x</b>");
    expect(renderText("{{__proto__}}{{a.b}}", { a: { b: 2 } })).toBe("2");
  });
});
describe("textOf", () => {
  it("picks the locale and falls back", () => {
    expect(textOf({ es: "Hola", en: "Hi" }, "en")).toBe("Hi");
    expect(textOf({ es: "Hola" }, "en")).toBe("Hola");
    expect(textOf("Fijo", "es")).toBe("Fijo");
  });
});

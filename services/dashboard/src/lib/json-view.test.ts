import { describe, it, expect } from "bun:test";
import { parseLoose, jsonHtml, validationIssues, issuesText, splitTrailingJson, renderJsonFences } from "./json-view.js";

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

describe("parseLoose", () => {
  it("parses plain and double-encoded JSON", () => {
    expect(parseLoose('{"a":1}')).toEqual({ value: { a: 1 }, truncated: false });
    expect(parseLoose(JSON.stringify(JSON.stringify({ a: 1 })))?.value).toEqual({ a: 1 });
  });

  it("repairs a payload the server cut mid-string and says so", () => {
    const cut = '{"to":"Integrador","subject":"SOLO web#2590","body":"El operador me pidió trab';
    const r = parseLoose(cut)!;
    expect(r.truncated).toBe(true);
    expect((r.value as Record<string, string>).subject).toBe("SOLO web#2590");
    expect((r.value as Record<string, string>).body).toStartWith("El operador");
  });

  it("drops a dangling key when the cut lands right after it", () => {
    const r = parseLoose('[{"a":1},{"b":2,"c"')!;
    expect(r.truncated).toBe(true);
    expect(r.value).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns null for prose", () => {
    expect(parseLoose("Posted to Nadia")).toBeNull();
  });
});

describe("jsonHtml", () => {
  it("keeps short objects on one line and colours each kind", () => {
    const html = jsonHtml({ repo: "web", n: 2590, ok: true, x: null });
    expect(html).toContain('class="jv-s"');
    expect(html).toContain('class="jv-n"');
    expect(html).toContain('class="jv-b"');
    expect(html).toContain('class="jv-z"');
    expect(html).not.toContain("jv-nest");
    expect(text(html)).toBe('{ repo: "web", n: 2590, ok: true, x: null }');
  });

  it("breaks big objects into rows and shows multi-line strings as text, not \\n escapes", () => {
    const html = jsonHtml({ subject: "SOLO web#2590", body: "línea uno\nlínea dos" });
    expect(html).toContain("jv-nest");
    expect(html).toContain('class="jv-text"');
    expect(html).not.toContain("\\n");
  });

  it("renders JSON fenced inside a string as JSON, so it cannot break the layout", () => {
    const body = 'Pedido del operador.\n\n```json\n{"mode":"only","only":"web#2590"}\n```\n';
    const html = jsonHtml({ body });
    expect(html).not.toContain("```");
    expect(text(html)).toContain('only: "web#2590"');
  });

  it("caps long arrays with a count of the rest", () => {
    const html = jsonHtml(Array.from({ length: 80 }, (_, i) => ({ id: i, name: `Office ${i}` })));
    expect(text(html)).toContain("+30 more");
  });

  it("escapes HTML in keys and values", () => {
    const html = jsonHtml({ "<b>": "<script>" });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
  });
});

describe("validation issues", () => {
  const zod = [{ code: "invalid_type", expected: "string", received: "undefined", path: ["body"], message: "Required" }];

  it("recognizes zod issues and says them in one line each", () => {
    expect(validationIssues(zod)).not.toBeNull();
    expect(issuesText(zod)).toBe("body: Required (expected string, got undefined)");
    expect(validationIssues([{ a: 1 }])).toBeNull();
  });

  it("splits a prose prefix from a JSON tail", () => {
    const s = "MCP error -32602: Invalid arguments: " + JSON.stringify(zod);
    const r = splitTrailingJson(s)!;
    expect(r.prefix).toBe("MCP error -32602: Invalid arguments:");
    expect(r.value).toEqual(zod);
  });

  it("renders the issues as a list, not raw JSON", () => {
    const html = jsonHtml(zod);
    expect(html).toContain("jv-issues");
    expect(text(html)).toContain("body: Required");
  });
});

describe("renderJsonFences", () => {
  it("replaces a ```json fence even when a string inside it holds backticks", () => {
    const src = 'Antes\n```json\n{"body":"x ```json {} ``` y"}\n```\nDespués';
    const out = renderJsonFences(src, (html) => `[[${html.length}]]`);
    expect(out.text).toStartWith("Antes\n[[");
    expect(out.text).toEndWith("]]\nDespués");
    expect(out.blocks).toHaveLength(1);
  });

  it("leaves a fence it cannot parse for the markdown pass", () => {
    const src = "```json\n{not json}\n```";
    expect(renderJsonFences(src, () => "X").text).toBe(src);
  });
});

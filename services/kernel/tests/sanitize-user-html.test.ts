import { describe, expect, test } from "bun:test";
import { sanitizeUserHtml } from "../src/sdk/sanitize-html.js";

// The email HTML a stranger sends lands here (comms ingress) before the dashboard shows it.
// Each payload is the shape of a published sanitize-html bypass; none may leave markup that runs.
const runs = (html: string) => /<(script|img|svg|iframe|meta|textarea|noscript|xmp)\b[^>]*\b(on\w+|srcdoc)=|javascript:|<script\b|http-equiv/i.test(html);

describe("sanitizeUserHtml", () => {
  test("raw-text tags do not smuggle markup through (xmp)", () => {
    expect(runs(sanitizeUserHtml(`<xmp><img src=x onerror=alert(1)></xmp>`))).toBe(false);
  });

  test("a self-closing textarea does not end the discard early", () => {
    expect(runs(sanitizeUserHtml(`<textarea/></textarea/><img src=x onerror=alert(1)>`))).toBe(false);
  });

  test("noscript content does not render as markup", () => {
    expect(runs(sanitizeUserHtml(`<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>`))).toBe(false);
  });

  test("meta refresh and scriptable URLs are dropped", () => {
    const out = sanitizeUserHtml(`<meta http-equiv="refresh" content="0;url=javascript:alert(1)"><a href="javascript:alert(1)">x</a><img src="javascript:alert(1)">`);
    expect(runs(out)).toBe(false);
  });

  test("SVG animation cannot set a javascript: href", () => {
    expect(runs(sanitizeUserHtml(`<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>`))).toBe(false);
  });

  test("ordinary mail markup survives, links open safely", () => {
    const out = sanitizeUserHtml(`<p>Hola <strong>Ana</strong></p><a href="https://example.com">link</a><img src="cid:logo">`);
    expect(out).toContain("<p>Hola <strong>Ana</strong></p>");
    expect(out).toContain(`href="https://example.com"`);
    expect(out).toContain(`rel="noopener noreferrer"`);
    expect(out).toContain(`src="cid:logo"`);
  });
});

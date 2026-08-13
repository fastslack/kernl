/**
 * The sanitizer must remove markup, not words.
 *
 * DOMPurify treats a text node as a tag named `#text` and adds it to
 * ALLOWED_TAGS for you — unless you supply your own list, which replaces the
 * default outright. Combined with `KEEP_CONTENT: false`, every text node was
 * then an unlisted node and was dropped like any other.
 *
 * Nothing about that is visible in the config: the allowlist reads like a
 * sensible set of tags, and the output is well-formed HTML. It just has no
 * words in it. A 9,958-character article came out as 10 characters — the RSS
 * reader rendered empty bullets and blank paragraphs, and every other
 * `{@html sanitizeHtml(...)}` surface (email bodies, agent output) lost its
 * text the same way.
 */

import { describe, it, expect } from "bun:test";
import { sanitizeHtml } from "./sanitize.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("sanitizeHtml", () => {
  it("keeps the text of allowed elements", () => {
    const out = sanitizeHtml("<p>The opening paragraph.</p>");
    expect(text(out)).toBe("The opening paragraph.");
  });

  it("keeps list item text — the shape that rendered as empty bullets", () => {
    const out = sanitizeHtml("<ul><li>First point</li><li>Second point</li></ul>");
    expect(text(out)).toContain("First point");
    expect(text(out)).toContain("Second point");
  });

  it("keeps text nested inside inline markup", () => {
    const out = sanitizeHtml("<p><b><i>Update on July 29:</i></b> details follow.</p>");
    expect(text(out)).toBe("Update on July 29: details follow.");
  });

  it("preserves an article end to end, not just its skeleton", () => {
    const article = `<p>${"Sentence about the incident. ".repeat(20)}</p>
      <h2>Timeline</h2><ul><li>${"A step in the timeline. ".repeat(6)}</li></ul>`;
    const out = sanitizeHtml(article);
    expect(text(out).length).toBeGreaterThan(600);
  });

  it("still drops a forbidden tag together with its text", () => {
    // KEEP_CONTENT stays false so this does not leak through as prose.
    const out = sanitizeHtml("<p>visible</p><script>alert('pwned')</script>");
    expect(out).not.toContain("pwned");
    expect(text(out)).toBe("visible");
  });

  it("still strips event handlers and style", () => {
    const out = sanitizeHtml(`<img src="x" onerror="alert(1)"><p style="color:red">hi</p>`);
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("style=");
    expect(text(out)).toBe("hi");
  });

  it("still refuses a javascript: href while keeping the words", () => {
    const out = sanitizeHtml(`<p><a href="javascript:alert(1)">click me</a></p>`);
    expect(out).not.toContain("javascript:");
    expect(text(out)).toBe("click me");
  });

  it("returns an empty string for nullish input", () => {
    expect(sanitizeHtml(null)).toBe("");
    expect(sanitizeHtml(undefined)).toBe("");
  });
});

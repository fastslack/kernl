/**
 * Agent output arrives as markdown, as a JSON envelope, or as a preview the
 * server sliced mid-string. Each of those had a bug that reached the screen —
 * mangled JSON, literal asterisks, a broken code fence — so each has a case here.
 *
 * `formatRunOutput` takes an explicit base URL in tests; in the browser it
 * defaults to `window.location.href`.
 */

import { describe, it, expect } from "bun:test";
import {
  TRUNC_MARK,
  unescapeJsonish,
  sanitizePreview,
  formatInline,
  linkifyUuids,
  formatRunOutput,
} from "./run-format.js";

const BASE = "http://dash.local/";

describe("unescapeJsonish", () => {
  it("unwraps a whole value that is a quoted JSON string", () => {
    expect(unescapeJsonish('"line one\\nline two"')).toBe("line one\nline two");
  });

  it("undoes escape sequences embedded in prose", () => {
    expect(unescapeJsonish('he said \\"hi\\"\\nbye')).toBe('he said "hi"\nbye');
  });

  it("leaves ordinary text untouched", () => {
    expect(unescapeJsonish("plain text")).toBe("plain text");
    expect(unescapeJsonish("")).toBe("");
  });
});

describe("sanitizePreview", () => {
  it("drops trailing half-open markdown markers", () => {
    // Whitespace is trimmed before the marker is removed, not after, so the
    // space that preceded the `**` survives. Preserved as-is: the panels
    // have rendered it this way all along.
    expect(sanitizePreview("bold start **", 10, 2000)).toBe("bold start ");
    expect(sanitizePreview("heading\n## ", 10, 2000)).toBe("heading");
  });

  it("keeps the closing backtick of a code fence", () => {
    const fenced = "```json\n{}\n```";
    expect(sanitizePreview(fenced, 10, 2000)).toBe(fenced);
  });

  it("appends the truncation sentinel only when the server cap was hit", () => {
    expect(sanitizePreview("text", 2000, 2000)).toContain(TRUNC_MARK);
    expect(sanitizePreview("text", 12, 2000)).not.toContain(TRUNC_MARK);
  });
});

describe("formatInline", () => {
  it("renders the inline subset without block wrappers", () => {
    expect(formatInline("**Wren:** ship it")).toBe("<strong>Wren:</strong> ship it");
    expect(formatInline("use `bun test`")).toBe("use <code>bun test</code>");
  });

  it("strips a leading bullet, including on a nested item", () => {
    expect(formatInline("  - **Wren:** ok")).toBe("<strong>Wren:</strong> ok");
  });

  it("escapes html before formatting", () => {
    expect(formatInline("<script>x</script>")).toBe("&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("linkifyUuids", () => {
  it("turns a bare uuid into a button carrying the full id", () => {
    const html = linkifyUuids("run 9fc67992-9f58-4885-aa08-846e17c6cf59 done");
    expect(html).toContain('data-comm-id="9fc67992-9f58-4885-aa08-846e17c6cf59"');
    expect(html).toContain("9fc67992…");
  });

  it("leaves text without uuids alone", () => {
    expect(linkifyUuids("nothing here")).toBe("nothing here");
  });
});

describe("formatRunOutput", () => {
  it("is empty for empty input", () => {
    expect(formatRunOutput("")).toBe("");
    expect(formatRunOutput(null)).toBe("");
  });

  it("renders headers, bold and lists", () => {
    const html = formatRunOutput("## Title\n\n- one\n- two", BASE);
    expect(html).toContain('<h3 class="md-h">Title</h3>');
    expect(html).toContain('<ul class="md-ul">');
    expect(html).toContain("<li>one</li>");
  });

  it("protects fenced code from the markdown rules", () => {
    const html = formatRunOutput("```\n## not a header\n```", BASE);
    expect(html).toContain('<pre class="md-codeblock">');
    expect(html).not.toContain("<h3");
  });

  it("unwraps an MCP content envelope instead of rendering the JSON", () => {
    const payload = JSON.stringify({ content: [{ type: "text", text: "**done**" }] });
    const html = formatRunOutput(payload, BASE);
    expect(html).toContain("<strong>done</strong>");
    expect(html).not.toContain("md-codeblock");
  });

  it("keeps the raw envelope in a details block when it unwraps a content field", () => {
    const payload = JSON.stringify({ content: "hello", metadata: { a: 1 } });
    const html = formatRunOutput(payload, BASE);
    expect(html).toContain("hello");
    expect(html).toContain('<details class="md-envelope">');
  });

  it("pretty-prints json that has no known content field", () => {
    const html = formatRunOutput('{"a":1}', BASE);
    expect(html).toContain('<pre class="md-codeblock">');
    expect(html).toContain("&quot;a&quot;");
  });

  it("allows http links and rejects javascript: ones", () => {
    expect(formatRunOutput("[ok](https://example.com)", BASE))
      .toContain('<a href="https://example.com/" target="_blank" rel="noopener noreferrer">ok</a>');
    const bad = formatRunOutput("[x](javascript:alert(1))", BASE);
    expect(bad).not.toContain("<a href");
    expect(bad).toContain("x");
  });

  it("renders the truncation sentinel as a callout", () => {
    const html = formatRunOutput("text" + "\n\n" + TRUNC_MARK, BASE);
    expect(html).toContain("md-trunc-hint");
    expect(html).not.toContain(TRUNC_MARK);
  });
});

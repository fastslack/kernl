/**
 * The chat's markdown renderer. It used to live inside `routes/chat/+page.svelte`
 * and only linked `[label](url)` — a URL written on its own stayed plain text,
 * so "Feed added: https://…/rss" was something you had to select and copy.
 *
 * Autolinking a bare URL is easy to get wrong: run the pass over the HTML this
 * function has already built and it rewrites the URLs inside `<code>` blocks and
 * inside the `href` of the links it just made. Hence the placeholder stash — and
 * hence these tests.
 */

import { describe, it, expect } from "bun:test";
import { formatMd } from "./chat-md.js";

describe("formatMd", () => {
  it("turns a bare URL into a link", () => {
    const out = formatMd("Feed added: https://a.dev/rss");
    expect(out).toContain('<a href="https://a.dev/rss"');
    expect(out).toContain('target="_blank"');
  });

  it("leaves a URL inside inline code alone", () => {
    const out = formatMd("run `curl https://a.dev/rss`");
    expect(out).not.toContain("<a ");
    expect(out).toContain("<code");
  });

  it("leaves a URL inside a fenced block alone", () => {
    const out = formatMd("```\ncurl https://a.dev/rss\n```");
    expect(out).not.toContain("<a ");
  });

  it("does not linkify the href of a markdown link it just built", () => {
    const out = formatMd("[the feed](https://a.dev/rss)");
    expect(out.match(/<a /g)?.length).toBe(1);
    expect(out).toContain(">the feed</a>");
  });

  it("keeps trailing punctuation out of the href", () => {
    const out = formatMd("it lives at https://a.dev/rss.");
    expect(out).toContain('href="https://a.dev/rss"');
    expect(out).toContain("</a>.");
  });

  it("renders a javascript: link as plain text", () => {
    const out = formatMd("[click](javascript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).toContain("click");
  });

  it("escapes HTML in the source text", () => {
    expect(formatMd("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });

  it("still renders the markdown it always did", () => {
    expect(formatMd("**bold**")).toContain("<strong>bold</strong>");
    expect(formatMd("- one\n- two")).toContain("<li>one</li>");
    expect(formatMd("## Title")).toContain("<h3>Title</h3>");
  });
});

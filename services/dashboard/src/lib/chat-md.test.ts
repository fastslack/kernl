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

/**
 * Reasoning models emit their scratchpad inline. It reached the transcript raw:
 * the user saw `<think>We need answer Spanish…</think>` sitting above every
 * reply. It is folded into a <details> now — these pin down that the answer
 * survives intact, that a half-streamed block folds too, and that nothing
 * inside the scratchpad leaks back out as markup.
 */
describe("formatMd — <think> folding", () => {
  const SAMPLE = "<think>\nWe need answer Spanish. Just hola.\n</think>\n\n¡Hola! ¿En qué te ayudo?";

  it("folds the block into a collapsed details", () => {
    const out = formatMd(SAMPLE);
    expect(out).toContain('<details class="think">');
    expect(out).not.toContain("open");
    expect(out).toContain("Razonamiento");
  });

  it("keeps the raw tags out of the transcript", () => {
    const out = formatMd(SAMPLE);
    expect(out).not.toContain("&lt;think&gt;");
    expect(out).not.toContain("&lt;/think&gt;");
  });

  it("leaves the actual answer untouched", () => {
    expect(formatMd(SAMPLE)).toContain("¡Hola! ¿En qué te ayudo?");
  });

  it("folds a block that has not finished streaming yet", () => {
    // The opening tag arrives seconds before the closing one. Matching only
    // balanced pairs left the scratchpad on screen for exactly that window.
    const out = formatMd("<think>\nStill reasoning about this");
    expect(out).toContain('<details class="think">');
    expect(out).toContain("Still reasoning about this");
    expect(out).not.toContain("&lt;think&gt;");
  });

  it("counts the words so the header says how much is hidden", () => {
    expect(formatMd("<think>one two three</think>")).toContain("3 palabras");
    expect(formatMd("<think>solo</think>")).toContain("1 palabra");
  });

  it("accepts the <thinking> spelling too", () => {
    expect(formatMd("<thinking>hmm</thinking>hi")).toContain('<details class="think">');
  });

  it("drops an empty scratchpad instead of rendering an empty card", () => {
    expect(formatMd("<think>\n\n</think>hi")).not.toContain("details");
  });

  it("does not autolink or reformat what the model only thought about", () => {
    // The block is stashed before every other pass, so a URL or **stars**
    // inside the scratchpad stay literal text.
    const out = formatMd("<think>check **bold** and https://evil.test</think>done");
    expect(out).not.toContain("<strong>bold</strong>");
    expect(out).not.toContain('href="https://evil.test"');
  });

  it("leaves a message with no scratchpad exactly as before", () => {
    expect(formatMd("just a reply")).toBe("<p>just a reply</p>");
  });
});

describe("lists", () => {
  it("keeps items tight instead of separating them with <br>", () => {
    const html = formatMd("- uno\n- dos\n- tres");
    expect(html).toContain("<ul><li>uno</li><li>dos</li><li>tres</li></ul>");
    expect(html).not.toContain("</li><br>");
  });

  it("wraps ordered lists too", () => {
    const html = formatMd("1. uno\n2. dos");
    expect(html).toContain("<ul><li>uno</li><li>dos</li></ul>");
  });

  it("does not leave the list inside a paragraph", () => {
    const html = formatMd("Herramientas:\n\n- notas\n- eventos\n\n¿Cuál querés?");
    expect(html).not.toMatch(/<p>[^<]*<ul>/);
    expect(html).toContain("¿Cuál querés?");
  });
});

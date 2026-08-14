/**
 * The chat's markdown renderer.
 *
 * A deliberately small subset — the transcript is assistant prose and tool
 * results, not a CMS. It lives here rather than inside `routes/chat/+page.svelte`
 * so the escaping and linking rules can be tested; see `chat-md.test.ts`.
 *
 * The one thing worth reading carefully is the stash. Code spans, fenced blocks
 * and finished anchors are pulled out into placeholders as soon as they are
 * built, so the later passes — bare-URL autolinking above all — cannot rewrite
 * a URL inside a code sample or inside an `href` that was already decided.
 */

/** Everything the renderer will follow. Anything else degrades to plain text. */
const SAFE_PROTOCOLS = ["http:", "https:", "mailto:"];

/**
 * Placeholder delimiter for stashed HTML. A private-use codepoint: it cannot
 * appear in the source text (the escaping pass has already run) and, unlike a
 * NUL byte, it leaves the file readable to grep and to the editor.
 */
const MARK = "\uE000";
const PLACEHOLDER = new RegExp(`${MARK}(\\d+)${MARK}`, "g");

function safeUrl(raw: string): string | null {
  // Root-relative paths are ours; `//host` is not a path, it's a protocol swap.
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const u = new URL(raw);
    return SAFE_PROTOCOLS.includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

function anchor(href: string, label: string): string {
  return `<a href="${href.replace(/"/g, "%22")}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

export function formatMd(text: string): string {
  if (!text) return "";

  const stash: string[] = [];
  const keep = (fragment: string): string => `${MARK}${stash.push(fragment) - 1}${MARK}`;

  let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Code blocks (```lang\n...\n```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const langLabel = lang ? `<span class="cb-lang">${lang}</span>` : "";
    return keep(`<div class="cb-wrap">${langLabel}<pre class="cb"><code>${code.trim()}</code></pre></div>`);
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, (_m, code) => keep(`<code class="ic">${code}</code>`));

  // Bold and italic
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // Headers
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");

  // Unordered lists
  html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

  // Links — validate the scheme so LLM-authored markdown can't emit a
  // `javascript:` URL (XSS) or break out of the href attribute. Only
  // http(s)/mailto survive; anything else renders as plain text.
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const safe = safeUrl(url);
    return safe ? keep(anchor(safe, label)) : label;
  });

  // Bare URLs. Tool results and assistants both write them plain — "the feed is
  // at https://…/rss" — and a URL you have to select and copy is not a link.
  html = html.replace(/https?:\/\/[^\s<>"'`]+/g, (match) => {
    const trailing = match.match(/[.,:!?)\]}"'*]+$/)?.[0] ?? "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    const safe = safeUrl(url);
    return safe ? keep(anchor(safe, url)) + trailing : match;
  });

  // Paragraphs (double newline)
  html = html.replace(/\n\n/g, "</p><p>");
  // Single newlines
  html = html.replace(/\n/g, "<br>");

  html = `<p>${html}</p>`.replace(/<p><\/p>/g, "");

  // Restore. A stashed anchor can hold a stashed code span in its label, so
  // keep swapping until nothing is left rather than assuming one pass.
  for (let pass = 0; pass < 5 && html.includes(MARK); pass++) {
    html = html.replace(PLACEHOLDER, (_m, i) => stash[Number(i)] ?? "");
  }

  return html;
}

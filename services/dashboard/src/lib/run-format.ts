/**
 * Rendering agent run output: preview clean-up and the markdown-ish formatter
 * behind the LIVE / HISTORY panels.
 *
 * Extracted verbatim from AgentWorld3D.svelte. Two things changed, both to
 * remove duplication rather than behaviour:
 *   - `escapeHtml` and the link-protocol check now come from `$shared/escape`,
 *     which already exported identical logic.
 *   - `formatRunOutput` takes an optional `baseUrl` so relative links resolve
 *     without a live `window` — that is what makes it testable at all.
 *
 * This is deliberately NOT merged with `chat-md.ts` or `mini-md.ts`. All three
 * are markdown-ish renderers with different rules, and folding them together
 * would change what each of their call sites renders.
 */

import { escapeHtml } from '$shared/escape.js';
import { jsonHtml, parseLoose, renderJsonFences, splitTrailingJson, validationIssues } from './json-view.js';
import { highlightCode } from './workspace-highlight.js';
import { codeBlockHtml, fenceLang, guessCode } from './code-guess.js';

/** Sentinel `sanitizePreview` plants and `formatRunOutput` renders as a callout. */
export const TRUNC_MARK = '\u0002TRUNCATED_HINT\u0002';

export { codeBlockHtml };

/** A terminal's output: monospace, one line per line, coloured when it is code. */
export function terminalHtml(text: string): string {
  const cut = text.indexOf(TRUNC_MARK);
  const body = cut >= 0 ? text.slice(0, cut) : text;
  const g = guessCode(body);
  const html = g ? codeBlockHtml(g.code, g.lang, g.lineNumbers) : codeBlockHtml(body.replace(/^\n+|\s+$/g, ''), '');
  return html + (cut >= 0 ? TRUNC_HTML : '');
}

const TRUNC_HTML = '<div class="md-trunc-hint">✂ Preview truncated by the server — open the HISTORY tab to see the full content.</div>';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Agent step previews sometimes arrive as JSON-encoded strings (i.e. the
 * server stored the LLM's reply via JSON.stringify, so newlines are `\n`
 * and quotes are `\"` when displayed verbatim). Detect that shape and
 * unwrap it so markdown formatting actually works. Safe no-op on content
 * that wasn't encoded.
 */
export function unescapeJsonish(s: string): string {
  if (!s) return s;
  const trimmed = s.trim();
  // Case 1: whole value is a quoted JSON string — unwrap it.
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch { /* fall through to inline */ }
  }
  // Case 2: literal escape sequences embedded in prose.
  if (/\\n|\\"|\\t|\\\\/.test(s)) {
    return s
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '  ')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
  }
  return s;
}

/**
 * Clean up a backend preview that was sliced mid-string. Drops trailing
 * half-open markdown markers (stray `**`, trailing `#`, open `` ` ``), then
 * — if the preview actually hit the server cap — appends a sentinel that
 * formatRunOutput renders as a styled callout (not markdown, because
 * underscores/asterisks in payload IDs leak as literal chars).
 */
export function sanitizePreview(text: string, rawLen: number, serverCap: number): string {
  let t = unescapeJsonish(String(text)).replace(/\s+$/, '');
  // strip trailing lone markdown markers that would render as raw asterisks
  t = t.replace(/(\*{1,3}|_{1,3})$/g, '');
  // Strip a stray trailing backtick ONLY if it isn't part of a ``` fence.
  // tool_call / tool_result previews wrap their payload in ```json … ```;
  // chopping a backtick off the closing fence breaks the markdown regex in
  // formatRunOutput and the fence renders as literal text.
  t = t.replace(/(?<!`)`$/g, '');
  t = t.replace(/\n\s*-\s*\**$/g, '');
  t = t.replace(/\n\s*#{1,6}\s*$/g, '');
  if (rawLen >= serverCap) t += '\n\n' + TRUNC_MARK;
  return t;
}

/** Turn bare UUIDs into buttons that open the matching entity. */
export function linkifyUuids(html: string): string {
  return html.replace(UUID_RE, (m) => `<button type="button" class="ip-uuid-link" data-comm-id="${m}" title="Open ${m}">${m.slice(0, 8)}…</button>`);
}

/**
 * Inline markdown for a single-line list item.
 *
 * Decisions and action items were printed raw, so the `**bold**` the
 * moderator writes showed up as literal asterisks in the summary — the one
 * part of the meeting a reader actually skims. They can't go through
 * formatRunOutput: that is a block renderer and would nest a <p> (and
 * possibly a whole <ul>) inside each <li>. This does the inline subset and
 * nothing else.
 *
 * It also drops a leading bullet marker. `extractBullets` strips one only
 * when the line starts with it, so a NESTED item ("  - **Wren:** …") kept
 * its dash and rendered as "- **Wren:** …" — visible in the summary as a
 * stray hyphen before half the action items.
 */
export function formatInline(text: string | undefined | null): string {
  if (!text) return '';
  let t = String(text).trim().replace(/^[-*•]\s+/, '').trim();
  t = escapeHtml(t);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)]|$)/g, '$1<em>$2</em>');
  return t;
}

/** Base used to resolve relative links; falls back when there is no window. */
function defaultBaseUrl(): string {
  return typeof window !== 'undefined' && window.location
    ? window.location.href
    : 'http://localhost/';
}

export function formatRunOutput(text: string | undefined | null, baseUrl?: string): string {
  if (!text) return '';
  const base = baseUrl ?? defaultBaseUrl();

  // ── JSON envelope unwrapping ───────────────────
  // The Claude Code SDK and several builtin handlers return a JSON envelope
  // like { most_recent_output: { content: "...markdown..." } } or
  // { content: "...", metadata: {...} }. Treating the whole envelope as
  // markdown destroys it: the `{` and `"key":` lines turn into <p>s, and
  // the `**bold**` markers inside the content string fight with the JSON
  // braces. Detect that shape and extract the human-facing payload before
  // running the regular markdown pass.
  const trimmed = String(text).trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // MCP shape: { content: [{ type: "text", text: "..." }, …], isError?: bool }.
      // Concatenate every text part and recurse — the agent's prose lives there.
      if (Array.isArray(parsed.content)) {
        const parts: string[] = [];
        for (const item of parsed.content as unknown[]) {
          if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
            parts.push(String((item as Record<string, unknown>).text ?? ""));
          }
        }
        if (parts.length > 0) {
          const flag = parsed.isError ? "⚠ tool error\n\n" : "";
          return formatRunOutput(flag + parts.join("\n\n"), base);
        }
      }
      const mro = parsed.most_recent_output as Record<string, unknown> | undefined;
      const candidate =
        (typeof mro?.content === "string" && mro.content) ||
        (typeof parsed.content === "string" && parsed.content as string) ||
        (typeof parsed.result === "string" && parsed.result as string) ||
        (typeof parsed.summary === "string" && parsed.summary as string) ||
        "";
      if (candidate) {
        // Recurse — the extracted string IS the markdown the agent wrote.
        // Append the structured envelope at the bottom inside a collapsed
        // <details> so power users can still inspect it.
        return formatRunOutput(candidate, base) +
          '<details class="md-envelope"><summary>raw JSON envelope</summary>' +
          `${linkifyUuids(jsonHtml(parsed))}</details>`;
      }
      // It's JSON but doesn't have a known content field — render it with
      // the JSON viewer instead of as markdown.
      return linkifyUuids(jsonHtml(parsed));
    } catch {
      // Not actually valid JSON — fall through to the markdown pass.
    }
  }

  // A top-level array, or JSON cut by a preview cap, goes to the viewer whole.
  if (trimmed.startsWith("[") || (trimmed.startsWith("{") && !trimmed.endsWith("}"))) {
    const loose = parseLoose(trimmed);
    if (loose && typeof loose.value === "object" && loose.value !== null) return linkifyUuids(jsonHtml(loose.value, { truncated: loose.truncated }));
  }
  // "MCP error -32602: Invalid arguments: [...zod issues...]": the prose, then
  // the issues one per line instead of a wall of JSON.
  const tail = splitTrailingJson(trimmed);
  if (tail && validationIssues(tail.value)) {
    return (tail.prefix ? `<p class="md-p">${escapeHtml(tail.prefix)}</p>` : "") + jsonHtml(tail.value);
  }

  // A body that is source code from top to bottom (a file a tool printed)
  // is shown as code, not as one paragraph per line.
  const cut = trimmed.indexOf(TRUNC_MARK);
  const code = guessCode(cut >= 0 ? trimmed.slice(0, cut) : trimmed);
  if (code) return codeBlockHtml(code.code, code.lang, code.lineNumbers) + (cut >= 0 ? TRUNC_HTML : "");

  // ```json fences go to the viewer first. A scanner finds where the JSON
  // really ends, so a string inside it holding its own ``` can't close the
  // fence early (an agent's letter with a json block in its body did).
  const jsonStash: string[] = [];
  const withJson = renderJsonFences(String(text), (html) => {
    jsonStash.push(html);
    return `\n\u0000JSONBLOCK${jsonStash.length - 1}\u0000\n`;
  }).text;

  // Protect triple-backtick fenced blocks from every markdown rule below.
  // Without this, JSON content that contains ## / ** / etc. gets mangled
  // (e.g. `## Context` inside a tool input becomes an <h3>).
  const fenceStash: string[] = [];
  const source = withJson.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, info, body) => {
    const idx = fenceStash.length;
    const text = String(body).replace(/\n$/, "");
    fenceStash.push(highlightCode(text, fenceLang(String(info)) || guessCode(text)?.lang || ""));
    return `\u0000CODEBLOCK${idx}\u0000`;
  });
  let html = escapeHtml(source);
  // headers
  html = html.replace(/^#{4,6}\s+(.+)$/gm, '<h5 class="md-h">$1</h5>');
  html = html.replace(/^###\s+(.+)$/gm, '<h4 class="md-h">$1</h4>');
  html = html.replace(/^##\s+(.+)$/gm, '<h3 class="md-h">$1</h3>');
  html = html.replace(/^#\s+(.+)$/gm, '<h3 class="md-h">$1</h3>');
  // bold then italic (careful order)
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // inline code
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');
  // links [text](url) — reject anything that isn't http(s)/mailto, otherwise
  // an agent that ingested external content could output `[x](javascript:...)`
  // and pop XSS in this dashboard.
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, linkText: string, url: string) => {
    let href: string | null = null;
    try {
      const u = new URL(url, base);
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
        href = u.toString();
      }
    } catch { href = null; }
    if (!href) return escapeHtml(linkText);
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
  });
  // lists + paragraphs
  const lines = html.split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (const raw of lines) {
    const ul = /^\s*[-*]\s+(.*)$/.exec(raw);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(raw);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul class="md-ul">'); listType = 'ul'; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol class="md-ol">'); listType = 'ol'; }
      out.push(`<li>${ol[1]}</li>`);
    } else if (raw.trim() === '') {
      closeList();
    } else {
      closeList();
      if (/^<h[1-6]/.test(raw.trim()) || /^\u0000(?:CODE|JSON)BLOCK\d+\u0000$/.test(raw.trim())) out.push(raw);
      else out.push(`<p class="md-p">${raw}</p>`);
    }
  }
  closeList();
  // JSON blocks go back before the UUID pass, so ids inside them open too.
  let joined = linkifyUuids(out.join('').replace(/\u0000JSONBLOCK(\d+)\u0000/g, (_m, idx) => jsonStash[Number(idx)]));
  // Restore the fenced code blocks as <pre>. They were escaped at stash time
  // so they're safe to drop back in as-is.
  joined = joined.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, idx) => {
    return `<pre class="md-codeblock code-view"><code>${fenceStash[Number(idx)]}</code></pre>`;
  });
  // Render the truncation sentinel as a visible callout. Both the raw
  // marker and an escaped variant (in case it went through escapeHtml
  // before the replace) are matched.
  joined = joined
    .replace(/\u0002TRUNCATED_HINT\u0002/g, TRUNC_HTML)
    .replace(/TRUNCATED_HINT/g, TRUNC_HTML); // defensive fallback
  return joined;
}

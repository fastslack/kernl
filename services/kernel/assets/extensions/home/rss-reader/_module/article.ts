/**
 * Pull the readable body out of an article page.
 *
 * Most feeds do not carry the article. Some ship `content:encoded` with the
 * whole post, many ship a one-line `<description>`, and a few — the Hugging
 * Face blog among them — ship nothing but a title and a link:
 *
 *   <item>
 *     <title>GPU Management: Why Idle GPUs Are the New Grounded Aircraft</title>
 *     <link>https://huggingface.co/blog/Dharma-AI/gpu-management</link>
 *   </item>
 *
 * The parser is not losing anything there; the text was never sent. So when the
 * reader opens an item with no body, the body has to be fetched from the page
 * the link points at and reduced to prose.
 *
 * Deliberately not a full Readability port: no DOM, no dependency. Strip the
 * furniture, prefer the element that semantically claims to be the article,
 * keep only the tags a reader needs. The frontend sanitises whatever comes
 * back, so the goal here is "the right text", not "safe HTML".
 */

/** Blocks that are never article text, removed with their contents. */
const FURNITURE = [
  "script", "style", "noscript", "iframe", "svg", "form", "button",
  "nav", "header", "footer", "aside", "template",
];

/** Tags worth keeping in the output. Everything else is unwrapped. */
const KEEP = new Set([
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "code",
  "strong", "em", "b", "i", "a", "img", "figure", "figcaption", "hr", "table",
  "thead", "tbody", "tr", "th", "td",
]);

/** Attributes worth keeping, per tag. Everything else is dropped. */
const KEEP_ATTRS: Record<string, string[]> = {
  a: ["href"],
  img: ["src", "alt"],
};

const MAX_BYTES = 2_000_000;   // don't swallow a 50MB page
const TIMEOUT_MS = 15_000;

function stripFurniture(html: string): string {
  let out = html;
  for (const tag of FURNITURE) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
    // Self-closing / unclosed variants.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), " ");
  }
  return out.replace(/<!--[\s\S]*?-->/g, " ");
}

/** Paired content elements, gathered in document order. */
const BLOCKS = ["p", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "pre", "figure", "table"];
/** Void elements that are content in their own right. Plenty of articles put
 *  images straight in the flow rather than wrapping them in a <figure>. */
const VOID_BLOCKS = ["img"];

/**
 * Every content block on the page, in order.
 *
 * Deliberately not "find the container that holds the article". A regex cannot
 * match a closing tag across nesting — `<div>…<div>…</div>…</div>` stops at the
 * first `</div>` — so scoring containers picked up arbitrary fragments: on a
 * WordPress post that meant a slice holding the figures and none of the prose,
 * which rendered as a column of charts with no article.
 *
 * Collecting the blocks themselves sidesteps nesting entirely. `<p>` and
 * friends are not nested inside each other, so a depth-aware scan over one tag
 * at a time is exact. The furniture is already gone by this point, so what is
 * left is the piece.
 */
function collectBlocks(html: string): string {
  const found: Array<{ at: number; html: string }> = [];
  const spans: Array<[number, number]> = [];

  for (const tag of BLOCKS) {
    const open = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    let m: RegExpExecArray | null;
    while ((m = open.exec(html)) !== null) {
      const end = findClose(html, tag, m.index + m[0].length);
      if (end < 0) continue;
      found.push({ at: m.index, html: html.slice(m.index, end) });
      spans.push([m.index, end]);
      open.lastIndex = end;
    }
  }

  for (const tag of VOID_BLOCKS) {
    const re = new RegExp(`<${tag}\\b[^>]*/?>`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      // Already carried by the figure or paragraph around it — taking it again
      // is how the same chart ended up printed twice.
      const at = m.index;
      if (spans.some(([s, e]) => at >= s && at < e)) continue;
      found.push({ at, html: m[0] });
    }
  }

  found.sort((a, b) => a.at - b.at);

  // A figure and its image can be reached twice on pages that repeat the hero
  // asset; the reader should show it once.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of found) {
    const key = block.html.replace(/\s+/g, " ").trim();
    if (key.length < 12 || seen.has(key)) continue;
    seen.add(key);
    out.push(block.html);
  }
  return dropLeadIn(out).join("\n");
}

/**
 * Drop the page furniture that sits inside the article container.
 *
 * "Back to Articles", an upvote count, a row of author handles, a repeat of
 * the headline — all inside <article> on a typical blog, so choosing the right
 * container does not remove them. They are short and text-only, which is what
 * separates them from the piece.
 *
 * Done over blocks rather than the joined string so a leading hero image
 * survives: an earlier pass sliced from the first long paragraph and threw the
 * opening figure away with the crumbs.
 */
function dropLeadIn(blocks: string[]): string[] {
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (/<img\b/i.test(b)) break;                        // a figure is content
    const text = b.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length >= 80) break;                        // a real sentence
    i++;
  }
  // Everything looked like furniture — more likely the heuristic is wrong than
  // that the page has no article, so keep what we have.
  return i === blocks.length ? blocks : blocks.slice(i);
}

/** Index just past the `</tag>` that closes the one opened at `from`. */
function findClose(html: string, tag: string, from: number): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/**
 * The article, as blocks.
 *
 * Scope to a semantic container when the page has one and it actually holds
 * the prose; otherwise take the whole (de-furnitured) page.
 */
function pickBody(html: string): string {
  for (const re of [
    /<article\b[^>]*>([\s\S]*)<\/article>/i,
    /<main\b[^>]*>([\s\S]*)<\/main>/i,
  ]) {
    const m = html.match(re);
    if (m && countProseChars(m[1]) > 200) return collectBlocks(m[1]);
  }
  return collectBlocks(html);
}

/** Visible characters inside <p> tags — the signal that this is prose. */
function countProseChars(html: string): number {
  let n = 0;
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) n += m[1].replace(/<[^>]+>/g, "").trim().length;
  return n;
}

/**
 * Drop every tag outside KEEP, and every attribute outside KEEP_ATTRS.
 *
 * The attribute part consumes quoted strings whole. Stopping at the first `>`
 * instead splits `class="[&>a]:hidden"` — a shape Tailwind emits constantly —
 * and spills `a]:hidden">` into the reader as if it were prose.
 */
function cleanTags(html: string): string {
  const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  return html.replace(TAG, (whole, rawName: string, attrs: string) => {
    const name = rawName.toLowerCase();
    if (!KEEP.has(name)) return " ";
    if (whole.startsWith("</")) return `</${name}>`;

    const allowed = KEEP_ATTRS[name];
    if (!allowed) return `<${name}>`;
    const kept: string[] = [];
    for (const attr of allowed) {
      const m = attrs.match(new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
      const value = m?.[2] ?? m?.[3];
      // A javascript: href is the one thing worth refusing outright here.
      if (value && !/^\s*javascript:/i.test(value)) kept.push(`${attr}="${value}"`);
    }
    return kept.length ? `<${name} ${kept.join(" ")}>` : `<${name}>`;
  });
}

function tidy(html: string): string {
  return html
    .replace(/(\s|&nbsp;)+/g, " ")
    .replace(/(<p>\s*<\/p>)+/gi, "")
    .replace(/(<br>\s*){3,}/gi, "<br><br>")
    .trim();
}

/**
 * Make links and images work outside their origin.
 *
 * An extracted `<img src="/chart.png">` resolves against the dashboard once it
 * is rendered here, so every relative asset 404s and the article reads as a
 * column of broken images.
 */
function absolutise(html: string, baseUrl: string): string {
  let base: URL;
  try { base = new URL(baseUrl); } catch { return html; }
  return html.replace(/\b(href|src)="([^"]*)"/gi, (whole, attr: string, value: string) => {
    if (!value || /^(https?:|data:|mailto:|#)/i.test(value)) return whole;
    try { return `${attr}="${new URL(value, base).href}"`; } catch { return whole; }
  });
}

export interface ExtractedArticle {
  html: string;
  /** Visible characters — the caller decides whether it was worth storing. */
  length: number;
}

/** Extract from already-fetched HTML. Separated so it can be tested offline. */
export function extractArticle(pageHtml: string, baseUrl = ""): ExtractedArticle {
  const body = pickBody(stripFurniture(pageHtml));
  let html = tidy(cleanTags(body));
  if (baseUrl) html = absolutise(html, baseUrl);
  return { html, length: html.replace(/<[^>]+>/g, "").trim().length };
}

/**
 * Fetch a URL and extract its article body.
 *
 * Returns null rather than throwing: a feed pointing at a dead or hostile URL
 * must not turn into a 500 on opening an item.
 */
export async function fetchArticle(url: string): Promise<ExtractedArticle | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Some publishers serve a stub to unknown agents.
        "User-Agent": "Mozilla/5.0 (compatible; KernlReader/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text\/html|application\/xhtml/i.test(type)) return null;

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    // res.url, not the argument — relative assets must resolve against wherever
    // the redirects actually landed.
    const extracted = extractArticle(new TextDecoder("utf-8").decode(buf), res.url || url);
    return extracted.length >= 200 ? extracted : null;
  } catch {
    // Timeout, DNS, TLS, abort — all the same answer: no body available.
    return null;
  }
}

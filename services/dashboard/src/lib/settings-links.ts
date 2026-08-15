// Turn the URLs inside a settings field's description into real links.
//
// These descriptions routinely tell you where to go — "from the Cloudflare
// dashboard, under Zero Trust → Networks → Tunnels (one.dash.cloudflare.com)",
// "created at dash.cloudflare.com/profile/api-tokens". Rendered as flat text
// that is an address you have to select, copy and paste, which is a worse
// version of a link for no reason.
//
// The output is TOKENS, not HTML. Field descriptions come from extension
// manifests, and extensions can be installed from a marketplace — running
// `{@html}` over text from that source would hand any published extension a
// script tag in the settings page. Rendering tokens through Svelte's normal
// escaping means the worst a hostile description can do is show you a link,
// and even then only to somewhere http(s).

export type DescToken =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

/**
 * `[label](url)` — the explicit form. Preferred in manifests: it says exactly
 * what is a link and what it should read as, instead of relying on a guess.
 */
const MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * A bare `https://…`. Deliberately narrow: only an explicit scheme autolinks.
 *
 * The tempting rule — "anything that looks like a hostname" — turns `index.ts`
 * and `service.io` inside ordinary prose into links (`.ts` and `.io` are real
 * TLDs), and a settings description that links a filename to a website is
 * worse than one that links nothing. Manifests that want a bare-looking
 * address use the markdown form with the label they want shown.
 */
const BARE_URL = /https?:\/\/[^\s<>()[\]]+/g;

/** Punctuation that ends a sentence rather than belonging to the address. */
const TRAILING = /[.,;:!?'"»）)\]]+$/;

/** Only ever produce links the browser will treat as navigation. */
function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseDescription(input: string): DescToken[] {
  if (!input) return [];
  const tokens: DescToken[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === "text") last.text += text;
    else tokens.push({ kind: "text", text });
  };

  // Pass 1: markdown links carve the string into segments; pass 2 autolinks
  // whatever plain text is left between them.
  let cursor = 0;
  for (const m of input.matchAll(MD_LINK)) {
    const [whole, label, url] = m;
    const at = m.index ?? 0;
    autolink(input.slice(cursor, at), pushText, tokens);
    const href = safeHref(url!);
    // A link we would not follow degrades to the text it was written as,
    // rather than vanishing — the reader still sees what the author meant.
    if (href) tokens.push({ kind: "link", text: label!, href });
    else pushText(whole);
    cursor = at + whole.length;
  }
  autolink(input.slice(cursor), pushText, tokens);
  return tokens;
}

function autolink(
  segment: string,
  pushText: (t: string) => void,
  tokens: DescToken[],
): void {
  if (!segment) return;
  let cursor = 0;
  for (const m of segment.matchAll(BARE_URL)) {
    const at = m.index ?? 0;
    let raw = m[0];
    // "(see https://example.com)." must not swallow the closing punctuation.
    const trimmed = TRAILING.exec(raw);
    let tail = "";
    if (trimmed) {
      tail = trimmed[0];
      raw = raw.slice(0, raw.length - tail.length);
    }
    pushText(segment.slice(cursor, at));
    const href = safeHref(raw);
    if (href) tokens.push({ kind: "link", text: raw, href });
    else pushText(raw);
    pushText(tail);
    cursor = at + m[0].length;
  }
  pushText(segment.slice(cursor));
}

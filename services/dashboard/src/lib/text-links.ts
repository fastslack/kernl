/**
 * Splits plain text (an error from the kernel, a notice) into text and the
 * http(s) URLs in it, so a message that ends at the page where the problem is
 * fixed ("…y probá de nuevo: https://github.com/settings/…") can show that URL
 * as a link without rendering any HTML. Punctuation that closes a sentence
 * right after a URL stays text.
 */
export type TextPart = { text: string; href?: string };

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]}»"']+$/;

export function textLinks(text: string): TextPart[] {
  const out: TextPart[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0];
    const url = raw.replace(TRAILING, '');
    const start = m.index ?? 0;
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ text: url, href: url });
    at = start + url.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

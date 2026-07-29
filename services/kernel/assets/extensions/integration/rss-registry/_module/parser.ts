/**
 * Lightweight RSS / Atom parser. Avoids extra deps — uses regex to walk the
 * common shapes: <rss><channel><item> for RSS 2.0 / RSS 1.0 / RDF and
 * <feed><entry> for Atom. Good enough for 99% of real-world feeds; falls back
 * to "best effort" on anything weird.
 */

export interface ParsedItem {
  title: string;
  link: string;
  guid: string;
  author: string;
  description: string;
  content: string;
  image_url: string;
  published_at: string | null;
}

export interface ParsedFeed {
  title: string;
  description: string;
  link: string;
  items: ParsedItem[];
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  let out = s;
  for (const [k, v] of Object.entries(ENTITY_MAP)) {
    out = out.split(k).join(v);
  }
  out = out.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m, n) =>
    String.fromCharCode(parseInt(n, 16)),
  );
  return out;
}

function unwrapCdata(s: string): string {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  return decodeEntities(unwrapCdata(m[1])).trim();
}

function readAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\b([^>]*)/?>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  const ar = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i");
  const am = m[1].match(ar);
  return am ? am[1] : null;
}

function findImage(xml: string): string {
  const enclosure = xml.match(
    /<enclosure\b[^>]*url\s*=\s*"([^"]+)"[^>]*type\s*=\s*"image\/[^"]+"/i,
  );
  if (enclosure) return enclosure[1];
  const mediaContent = xml.match(
    /<media:content\b[^>]*url\s*=\s*"([^"]+)"[^>]*medium\s*=\s*"image"/i,
  );
  if (mediaContent) return mediaContent[1];
  const mediaThumb = xml.match(/<media:thumbnail\b[^>]*url\s*=\s*"([^"]+)"/i);
  if (mediaThumb) return mediaThumb[1];
  const inHtml = xml.match(/<img\b[^>]*src\s*=\s*"([^"]+)"/i);
  if (inHtml) return inHtml[1];
  return "";
}

function toIso(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseRssItem(itemXml: string): ParsedItem {
  const title = readTag(itemXml, "title") ?? "";
  const link =
    readTag(itemXml, "link") ??
    readAttr(itemXml, "link", "href") ??
    "";
  const guid = readTag(itemXml, "guid") ?? link;
  const author =
    readTag(itemXml, "dc:creator") ??
    readTag(itemXml, "author") ??
    "";
  const description = readTag(itemXml, "description") ?? "";
  const content =
    readTag(itemXml, "content:encoded") ??
    readTag(itemXml, "content") ??
    description;
  const pubDate =
    readTag(itemXml, "pubDate") ??
    readTag(itemXml, "dc:date") ??
    readTag(itemXml, "published") ??
    readTag(itemXml, "updated");

  return {
    title: stripTags(title),
    link: link.trim(),
    guid: guid.trim(),
    author: stripTags(author),
    description: stripTags(description).slice(0, 500),
    content,
    image_url: findImage(itemXml),
    published_at: toIso(pubDate),
  };
}

function parseAtomEntry(entryXml: string): ParsedItem {
  const title = readTag(entryXml, "title") ?? "";
  const link =
    readAttr(entryXml, "link", "href") ?? readTag(entryXml, "link") ?? "";
  const guid = readTag(entryXml, "id") ?? link;
  const author = readTag(entryXml, "name") ?? readTag(entryXml, "author") ?? "";
  const summary = readTag(entryXml, "summary") ?? "";
  const content = readTag(entryXml, "content") ?? summary;
  const pubDate =
    readTag(entryXml, "published") ?? readTag(entryXml, "updated");

  return {
    title: stripTags(title),
    link: link.trim(),
    guid: guid.trim(),
    author: stripTags(author),
    description: stripTags(summary).slice(0, 500),
    content,
    image_url: findImage(entryXml),
    published_at: toIso(pubDate),
  };
}

export function parseFeed(xml: string): ParsedFeed {
  const items: ParsedItem[] = [];

  // RSS 2.0 / RSS 1.0
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    items.push(parseRssItem(m[1]));
  }

  // Atom
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  while ((m = entryRe.exec(xml)) !== null) {
    items.push(parseAtomEntry(m[1]));
  }

  // Feed-level metadata. For RSS, look inside <channel>; for Atom inside <feed>.
  const channelMatch = xml.match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/i);
  const feedHead = channelMatch
    ? channelMatch[1].replace(/<item\b[\s\S]*?<\/item>/gi, "")
    : xml.replace(/<entry\b[\s\S]*?<\/entry>/gi, "");

  const title = readTag(feedHead, "title") ?? "";
  const description =
    readTag(feedHead, "description") ?? readTag(feedHead, "subtitle") ?? "";
  const link =
    readTag(feedHead, "link") ?? readAttr(feedHead, "link", "href") ?? "";

  return {
    title: stripTags(title),
    description: stripTags(description),
    link: link.trim(),
    items,
  };
}

/** Stable hash for an item — used to dedupe across re-fetches. */
export function itemHash(item: ParsedItem): string {
  const key = item.guid || item.link || item.title;
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = (h * 33) ^ key.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

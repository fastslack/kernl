// XSS sanitizer for any string an extension page renders via `{@html ...}`
// whose content originates outside the dashboard itself (RSS feeds, emails,
// agent output). Mirror of services/dashboard/src/lib/sanitize.ts, but built
// on plain `dompurify` — extension page bundles are client-only (the host
// route disables SSR), so the isomorphic wrapper (and its jsdom dependency)
// is unnecessary and would leak into the bundle under node resolution.

import DOMPurify from "dompurify";

const CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  ALLOWED_TAGS: [
    "a", "p", "br", "hr", "div", "span",
    "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "code", "pre",
    "blockquote", "q", "cite",
    "ul", "ol", "li",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th",
    "img",
  ],
  ALLOWED_ATTR: [
    "href", "title", "target", "rel",
    "src", "alt", "width", "height",
    "dir", "lang",
  ],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|cid:|data:image\/(?:png|jpe?g|gif|webp);)/i,
  FORBID_TAGS: ["script", "style", "iframe", "frame", "object", "embed", "link", "meta", "form", "input", "button", "select", "textarea"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "onchange", "onsubmit", "style", "srcdoc", "formaction"],
  ALLOW_DATA_ATTR: false,
  KEEP_CONTENT: false,
};

/** Sanitize an HTML string for safe rendering via `{@html ...}`. */
export function sanitizeHtml(raw: string | null | undefined): string {
  if (raw == null) return "";
  return DOMPurify.sanitize(String(raw), CONFIG) as unknown as string;
}

/**
 * Validate a URL coming from an external-origin string. Returns `null` for
 * any URL we don't want to follow — `javascript:`, `data:` non-images, etc.
 */
export function safeHref(raw: string): string | null {
  try {
    if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
    const u = new URL(raw, window.location.href);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") {
      return u.toString();
    }
    return null;
  } catch {
    return null;
  }
}

/** Escape a string for safe insertion as text content into HTML. */
export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

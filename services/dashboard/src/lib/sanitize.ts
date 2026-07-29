// XSS sanitizer for any string the dashboard renders via `{@html ...}` whose
// content originates outside the dashboard frontend itself: emails (IMAP),
// RSS feeds, agent output that includes external content, user posts.
//
// Backend already sanitizes at the comms ingress (see
// `src/core/sanitize-html.ts`), but we also sanitize on the frontend as a
// belt-and-braces defence — older rows in the DB pre-date the backend gate.
//
// Implementation: `isomorphic-dompurify` so the same call works during SSR
// (no `window`) and in the browser. Allowlist mirrors the backend's.

import DOMPurify from "isomorphic-dompurify";

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
 * Validate a URL coming from an external-origin string (e.g. an `[text](url)`
 * link in agent output, RSS, or email markdown). Returns `null` for any URL
 * we don't want to follow — `javascript:`, `data:` non-images, weird schemes.
 */
export function safeHref(raw: string): string | null {
  try {
    // Allow root-relative paths without parsing.
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

/**
 * Escape a string for safe insertion as text content into HTML. Use whenever
 * you must build a string that will end up inside `{@html ...}` and you have
 * a piece of untrusted data that should appear verbatim (no markup).
 */
export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

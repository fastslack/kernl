// XSS sanitizer for any string the dashboard or an extension page renders via
// `{@html ...}` whose content originates outside the frontend itself: emails
// (IMAP), RSS feeds, agent output that includes external content, user posts.
// The one copy — the dashboard imports it as `$shared/sanitize` too.
//
// Backend already sanitizes at the comms ingress (see
// `src/core/sanitize-html.ts`), but we also sanitize on the frontend as a
// belt-and-braces defence — older rows in the DB pre-date the backend gate.
//
// Implementation: plain `dompurify`. Extension page bundles and the dashboard
// SPA only ever sanitize in the browser (the extension host route disables SSR
// and the dashboard prerenders nothing), so the isomorphic wrapper — and the
// jsdom it drags along — is unnecessary and would leak into extension bundles
// under node resolution. Should this ever run without a DOM, `sanitizeHtml`
// escapes instead of sanitizing (see below). Allowlist mirrors the backend's.

import DOMPurify from "dompurify";
import { escapeHtml } from "./escape";

export { escapeHtml, safeHref } from "./escape";

const CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  ALLOWED_TAGS: [
    // DOMPurify treats text nodes as a tag named `#text`. It adds it for you
    // by default, but supplying ALLOWED_TAGS replaces that default outright —
    // and with KEEP_CONTENT: false below, a text node that is not on the list
    // is removed like any other disallowed node.
    //
    // The result was total: every `{@html sanitizeHtml(...)}` surface rendered
    // the tag skeleton with none of the words. The RSS reader showed empty
    // bullets and blank paragraphs; a 9,958-character article came out the far
    // side as 10 characters. Emails and agent output run through the same
    // function and were losing their text the same way.
    "#text",
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
  // Kept false on purpose, now that `#text` is allowed: the text inside a
  // *forbidden* tag still goes with it, so `<script>alert(1)</script>` leaves
  // nothing behind rather than printing its source as prose.
  KEEP_CONTENT: false,
};

/** Sanitize an HTML string for safe rendering via `{@html ...}`. */
export function sanitizeHtml(raw: string | null | undefined): string {
  if (raw == null) return "";
  // Without a DOM (SSR, a non-DOM test runner) plain DOMPurify cannot parse,
  // and `sanitize` is not even defined. Fail closed: render the markup as
  // inert text rather than throwing or passing it through.
  if (!DOMPurify.isSupported) return escapeHtml(raw);
  return DOMPurify.sanitize(String(raw), CONFIG) as unknown as string;
}

/**
 * HTML sanitizer for any user-derived or remote-origin string that the
 * dashboard renders via Svelte's `{@html ...}`. Currently used at the
 * comms ingress (IMAP/draft body_html) so the dashboard's email viewer
 * can't be turned into an XSS vector by a malicious sender.
 *
 * Allowlist is intentionally narrow: structure + inline emphasis +
 * tables + safe links/images. No `<script>`, no `<style>`, no `<iframe>`,
 * no `on*` handlers, no `javascript:` / `data:` URLs (except images).
 */

import sanitizeHtml from "sanitize-html";

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "p", "br", "hr", "div", "span",
    "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "code", "pre",
    "blockquote", "q", "cite",
    "ul", "ol", "li",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th",
    "img",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    "*": ["dir", "lang"],
  },
  // Only http(s) links and mailto for anchors. Images: only http(s) and
  // data: image MIME types (some senders inline small logos as base64).
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
  allowProtocolRelative: false,
  enforceHtmlBoundary: true,
  // Force every anchor to open externally with a safe rel — kills the
  // `target=_blank` reverse tabnabbing class of bugs.
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
  },
  // Drop the offending tag entirely, including its text content, for
  // anything not on the allowlist (vs. the default which keeps text).
  // Stops `<script>alert(1)</script>` from leaving `alert(1)` behind.
  disallowedTagsMode: "discard",
};

export function sanitizeUserHtml(raw: string | null | undefined): string {
  if (raw == null) return "";
  return sanitizeHtml(String(raw), OPTIONS);
}

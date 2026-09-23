// The DOM-free half of `$shared/sanitize`: plain string helpers with no
// DOMPurify behind them. They live in their own module so code that only needs
// to escape text (the dashboard's formatters, and their bun tests, which have
// no DOM and no `dompurify` on the resolution path from here) can import them
// without pulling the sanitizer in. `$shared/sanitize` re-exports both, so
// existing imports from there keep working.

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

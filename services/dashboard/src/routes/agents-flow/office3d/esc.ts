/**
 * HTML-escape a value before interpolating it into an `innerHTML` template.
 * Used for agent/rank/repo names that originate from the kernel DB (and can be
 * set by agents themselves), preventing stored XSS in the 3D office labels.
 */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

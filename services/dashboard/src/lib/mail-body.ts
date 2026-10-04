/**
 * Rendering a message's HTML in the mail view. The kernel stores it already
 * sanitized (no scripts, styles, frames or handlers); this adds the viewer's
 * own guards: remote images stay blocked until the user asks for them —
 * loading one tells the sender the mail was opened, when, and from where —
 * and the document runs in a sandboxed iframe under a CSP of its own.
 */

/**
 * Park every remote <img src> in data-blocked-src. The kernel's sanitizer
 * re-serializes markup, so attributes arrive normalized to `src="…"`.
 * Inline (data:) and cid: images are part of the message and stay.
 */
export function blockRemoteImages(html: string): { html: string; blocked: number } {
  let blocked = 0;
  const out = html.replace(/(<img\b[^>]*?)\ssrc="(https?:[^"]*)"/gi, (_m, head: string, src: string) => {
    blocked++;
    return `${head} data-blocked-src="${src}"`;
  });
  return { html: out, blocked };
}

/** Count of remote images a message would load. */
export function remoteImageCount(html: string): number {
  return blockRemoteImages(html).blocked;
}

const BASE_CSS = `
  html, body { margin: 0; padding: 0; background: #fff; color: #1f2328; }
  body { padding: 16px; font: 14px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; word-break: break-word; }
  img { max-width: 100%; height: auto; }
  img[data-blocked-src] { display: inline-block; min-width: 24px; min-height: 24px; background: #eef0f3; border: 1px dashed #c4c9d1; }
  table { max-width: 100%; border-collapse: collapse; }
  a { color: #0b62d6; }
  blockquote { margin: 0 0 0 8px; padding-left: 10px; border-left: 3px solid #d0d7de; color: #57606a; }
  pre { white-space: pre-wrap; }
`;

/**
 * The iframe document. The CSP is the second wall behind blockRemoteImages:
 * with images blocked it only admits inline data: images, so nothing remote
 * can load even if a src slipped past the rewrite. Scripts are never allowed.
 */
export function buildSrcdoc(html: string, showRemoteImages: boolean): string {
  const body = showRemoteImages ? html : blockRemoteImages(html).html;
  const imgSrc = showRemoteImages ? "data: cid: http: https:" : "data: cid:";
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'`;
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base target="_blank"><style>${BASE_CSS}</style></head><body>${body}</body></html>`;
}

/**
 * Fetch helpers the job-board scrapers share: a browser-like plain fetch, a
 * Browserless-rendered fetch for SPA boards, HTML-to-text and a cheap stable
 * id. Nothing else in the kernel uses them, so they travel with the extension.
 */

import { log } from "@kernl/extension-sdk";

export const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function fetchText(url: string, timeoutMs = 15000): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

export async function renderedHtml(
  url: string,
  opts: { waitUntil?: "domcontentloaded" | "networkidle2"; timeoutMs?: number } = {},
  browserlessUrl?: string,
): Promise<string | null> {
  // SPA-heavy boards (Workana, Arc) only populate the job list after the
  // XHR/hydration pass finishes — `domcontentloaded` returns a 15kb shell.
  // Default to `networkidle2` for these; callers can override per-platform.
  // `browserlessUrl` comes from `config.browserlessUrl`; env fallback kept for
  // any caller that can't reach config.
  const BROWSERLESS = browserlessUrl ?? process.env.BROWSERLESS_URL ?? "http://host.docker.internal:3333";
  const waitUntil = opts.waitUntil ?? "networkidle2";
  const timeout = opts.timeoutMs ?? 40000;
  try {
    const r = await fetch(`${BROWSERLESS}/content`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil, timeout: Math.max(timeout - 5000, 15000) },
        rejectResourceTypes: ["image", "media", "font"],
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return null;
    return await r.text();
  } catch (err) {
    log.debug(`renderedHtml(${url}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashId(...parts: string[]): string {
  // Cheap deterministic id — FNV-1a 32-bit hex. Good enough for dedupe keys.
  let h = 0x811c9dc5;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h ^= p.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

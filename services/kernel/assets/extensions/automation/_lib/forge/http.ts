/**
 * HTTP plumbing shared by the forge channels: the JSON request with the
 * rate-limit retry each of them carried, the Retry-After reading, and the
 * snapshot hash triage compares before acting on an item.
 */

import { createHash } from "node:crypto";

export const FORGE_USER_AGENT = "Kernl-triage/0.1";

export interface ForgeRequest {
  /** Provider label for the error message ("GitHub", "GitLab", "Gitea"). */
  label: string;
  method: string;
  /** API path, used in the error message. */
  path: string;
  url: string;
  /** A function is called on every attempt, so a retry can carry fresh credentials. */
  headers: Record<string, string> | (() => Promise<Record<string, string>>);
  body?: unknown;
  /** Statuses worth waiting on and retrying (429, 503, GitHub's 403). */
  retryOn: number[];
  /** Header carrying an epoch-seconds reset time, when the host sends one. */
  resetHeader?: string;
  /** Called on a 401 before the first retry; return true to retry once (GitHub refreshes its token). */
  onUnauthorized?: () => boolean;
}

const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000;

/** A JSON request that waits out a rate limit (up to 60 s, 3 tries) and throws with the host's reply otherwise. */
export async function forgeRequest<T>(req: ForgeRequest, attempt = 1): Promise<T> {
  const headers = typeof req.headers === "function" ? await req.headers() : req.headers;
  const res = await fetch(req.url, {
    method: req.method,
    headers: {
      "User-Agent": FORGE_USER_AGENT,
      ...headers,
      ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  if (res.status === 401 && attempt === 1 && req.onUnauthorized?.()) {
    return forgeRequest<T>(req, attempt + 1);
  }
  if (req.retryOn.includes(res.status) && attempt <= MAX_ATTEMPTS) {
    const waitMs = retryAfterMs(res, req.resetHeader);
    if (waitMs > 0 && waitMs <= MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, waitMs));
      return forgeRequest<T>(req, attempt + 1);
    }
  }
  const text = await res.text().catch(() => "");
  throw new Error(`${req.label} ${req.method} ${req.path} ${res.status}: ${text.slice(0, 300)}`);
}

/** Retry-After in seconds, else an epoch-seconds reset header, else 0 (do not wait). */
export function retryAfterMs(res: Response, resetHeader?: string): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) return n * 1000;
  }
  const reset = resetHeader ? res.headers.get(resetHeader) : null;
  if (reset) return Math.max(0, Number(reset) * 1000 - Date.now());
  return 0;
}

/** sha256 of the fields whose change should invalidate a proposed close. */
export function snapshotHash(fields: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/**
 * Walk an item's comments page by page for one containing `marker`: update
 * it if found, else create one. The bot keeps a single durable comment per
 * item instead of adding a new one on every run.
 */
export async function upsertMarked<C extends { id: number | string; body: string }, R>(opts: {
  pageSize: number;
  listPage: (page: number) => Promise<C[]>;
  matches?: (comment: C) => boolean;
  update: (existing: C) => Promise<R>;
  create: () => Promise<R>;
  marker: string;
}): Promise<R> {
  for (let page = 1; page <= 20; page++) {
    const comments = await opts.listPage(page);
    if (comments.length === 0) break;
    const existing = comments.find((c) => (opts.matches ? opts.matches(c) : true) && c.body.includes(opts.marker));
    if (existing) return opts.update(existing);
    if (comments.length < opts.pageSize) break;
  }
  return opts.create();
}

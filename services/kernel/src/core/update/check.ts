/**
 * Is there a newer Kernl than the one running?
 *
 * Answering that is the whole feature. It deliberately stops short of
 * downloading or applying anything, and that restraint is the design rather
 * than a first step toward silent updates:
 *
 * Kernl is a server holding a SQLite database whose migrations run at boot and
 * only go forward. Reinstalling the previous version does not undo migration
 * 017. A desktop app can swap itself while you are not looking; something that
 * owns your data cannot, so the update has to be a moment the user chose.
 * `apply.ts` is that moment, and it is only ever reached from a button.
 *
 * ── Failures are not answers ───────────────────────────────────────────────
 * A successful check is cached for six hours, because the release host has no
 * business hearing from every dashboard load. A FAILED one is cached for a
 * minute, and a rate-limited one for five. Caching a failure for six hours —
 * which is what this did — meant one flaky moment hid a published release for
 * the rest of the day, and the only way out was the About card's "Check for
 * updates" button, which passes `fresh` and which nobody clicks when the UI is
 * quiet because a quiet UI means "nothing to do".
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

export interface UpdateStatus {
  /** Version this process is running. */
  current: string;
  /** Newest published release, or null when the check could not answer. */
  latest: string | null;
  /** True only when `latest` is genuinely newer than `current`. */
  updateAvailable: boolean;
  /** Release page for a human to read before deciding. */
  url: string | null;
  /** Epoch ms of the last successful check; null if never. */
  checkedAt: number | null;
  /** Why there is no answer, when there is none. */
  reason?: "no-releases" | "offline" | "rate-limited" | "unknown-version";
}

// ── Version comparison (pure) ───────────────────────────────────────────────

interface Parsed {
  nums: number[];
  /** Prerelease identifiers, empty for a final release. */
  pre: string[];
}

function parse(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

/**
 * Semver ordering, enough of it for this: -1 if a < b, 0 if equal, 1 if a > b.
 *
 * The prerelease rule is the one that matters and the one people get wrong.
 * `0.2.0-rc.1` is OLDER than `0.2.0`, not newer — the current version here is
 * exactly such a string, so getting this backwards would announce an update
 * to the release the user already has, or hide the real one.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;

  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }

  // Same numbers: a prerelease loses to the final release.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    const bothNumeric = !Number.isNaN(nx) && !Number.isNaN(ny);
    if (bothNumeric) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ── Current version ─────────────────────────────────────────────────────────

let cachedVersion: string | null = null;

/**
 * The running version, from the same package.json the release workflow's
 * version-check job compares the tag against. Reading anything else would
 * reintroduce the drift that guard exists to catch.
 */
export function currentVersion(): string | null {
  if (cachedVersion) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  // dev: src/core/update → up three. Packaged: the bundle sits beside its
  // package.json, which stage-payload copies next to mcp-server.js.
  for (const c of [resolve(here, "../../.."), here, resolve(here, "..")]) {
    const p = resolve(c, "package.json");
    if (!existsSync(p)) continue;
    try {
      const v = JSON.parse(readFileSync(p, "utf-8")).version;
      if (typeof v === "string" && v) {
        cachedVersion = v;
        return v;
      }
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// ── The check ───────────────────────────────────────────────────────────────

const REPO = process.env.KERNEL_UPDATE_REPO ?? "fastslack/kernl";

/** A good answer is worth six hours. */
const TTL_MS = 6 * 60 * 60 * 1000;
/** A connection that failed is worth a minute: it was not an answer. */
const FAILURE_TTL_MS = 60 * 1000;
/** Unauthenticated GitHub resets hourly; five minutes is polite and useful. */
const RATE_LIMIT_TTL_MS = 5 * 60 * 1000;

/**
 * GitHub asks every client to identify itself, and an unauthenticated caller
 * gets 60 requests an hour per IP — shared by everyone behind the same NAT.
 * Saying who we are is what makes a 403 legible as "rate limited" instead of
 * arriving as an anonymous failure. Same convention as `job-scrapers.ts`.
 */
export const UPDATE_USER_AGENT = "Kernl-Updater (+https://github.com/fastslack/kernl)";

/** Headers every call to the release host carries. */
export function githubHeaders(): Record<string, string> {
  return {
    "User-Agent": UPDATE_USER_AGENT,
    Accept: "application/vnd.github+json",
  };
}

/** No request to the release host may hang forever. */
export const REQUEST_TIMEOUT_MS = 15_000;

let cache: { at: number; ttl: number; status: UpdateStatus } | null = null;

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Ask GitHub for the newest release. Cached — for six hours on success, a
 * minute on failure — and never throws: an update check that breaks the
 * dashboard is worse than one that says nothing. `fetchImpl` is injectable so
 * the comparison and caching logic can be tested without a network.
 */
export async function checkForUpdate(
  opts: { fresh?: boolean; fetchImpl?: FetchLike } = {},
): Promise<UpdateStatus> {
  const now = Date.now();
  if (!opts.fresh && cache && now - cache.at < cache.ttl) return cache.status;

  const current = currentVersion();
  if (!current) {
    return {
      current: "unknown",
      latest: null,
      updateAvailable: false,
      url: null,
      checkedAt: null,
      reason: "unknown-version",
    };
  }

  const base: UpdateStatus = {
    current,
    latest: null,
    updateAvailable: false,
    url: null,
    checkedAt: null,
  };

  const doFetch: FetchLike =
    opts.fetchImpl ??
    ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);

  let status: UpdateStatus;
  let ttl = TTL_MS;
  try {
    const res = await doFetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) {
      // No published release. A real answer, so it caches like one.
      status = { ...base, checkedAt: now, reason: "no-releases" };
    } else if (res.status === 403 || res.status === 429) {
      // Rate limited rather than broken: worth saying, and worth backing off.
      status = { ...base, reason: "rate-limited" };
      ttl = RATE_LIMIT_TTL_MS;
    } else if (!res.ok) {
      status = { ...base, reason: "offline" };
      ttl = FAILURE_TTL_MS;
    } else {
      const body = (await res.json()) as { tag_name?: string; html_url?: string };
      const latest = (body.tag_name ?? "").replace(/^v/, "");
      status = latest
        ? {
            current,
            latest,
            updateAvailable: compareVersions(current, latest) < 0,
            url: body.html_url ?? null,
            checkedAt: now,
          }
        : { ...base, checkedAt: now, reason: "no-releases" };
    }
  } catch {
    // Offline, DNS down, timed out — all the same to the caller, and none of
    // them an answer worth keeping for six hours.
    status = { ...base, reason: "offline" };
    ttl = FAILURE_TTL_MS;
  }

  cache = { at: now, ttl, status };
  if (status.updateAvailable) {
    log.info(`Update available: ${status.current} → ${status.latest}`);
  }
  return status;
}

/** Drop the cache. Tests, and an explicit "check now" from the UI. */
export function resetUpdateCache(): void {
  cache = null;
}

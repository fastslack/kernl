/**
 * LicenseService — single source of truth for "is this kernel Pro?".
 *
 * The on-disk license is a plain JWT file under the standard XDG config
 * path. No DB, no encryption — the JWT is its own integrity proof, and the
 * embedded public key in this codebase is what validates it. Anyone with
 * the file has the license; that's intentional (a user moving machines
 * just copies one file).
 *
 * Free modules never need to look at this; they simply don't import it.
 * Pro modules call `ctx.license.has("pro:trading")` in their `initialize()`
 * before registering real tools.
 */

import { mkdir, readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

import { log } from "../logger.js";
import {
  LicenseError,
  type LicenseClaim,
  type LicenseService,
  type LicenseSku,
  type LicenseStatus,
  type LicenseStatusReport,
} from "./types.js";
import { verifyLicenseJwt } from "./verify.js";

/**
 * XDG-ish config path. We deliberately stay under `~/.config/kernl/` so
 * the license is per-user and unaffected by the kernel install location.
 * Windows uses %APPDATA%; honoured via XDG_CONFIG_HOME when the launcher
 * sets it (the .app/.msi wrappers do).
 */
function defaultLicensePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : resolve(homedir(), ".config");
  return resolve(base, "kernl", "license.jwt");
}

export interface LicenseServiceOptions {
  /** Override the file location. Tests pass a tmp path; production uses default. */
  path?: string;
}

export function createLicenseService(opts: LicenseServiceOptions = {}): LicenseService {
  const path = opts.path ?? defaultLicensePath();
  let cached: LicenseStatusReport = { status: "none" };
  let cachedJwt: string | null = null;

  async function readJwtFile(): Promise<string | null> {
    if (!existsSync(path)) return null;
    try {
      const raw = (await readFile(path, "utf-8")).trim();
      return raw.length > 0 ? raw : null;
    } catch (err) {
      log.warn(`license: failed to read ${path}`, err);
      return null;
    }
  }

  async function verifyAndCache(jwt: string | null): Promise<LicenseStatusReport> {
    if (jwt == null) {
      cachedJwt = null;
      cached = { status: "none" };
      return cached;
    }
    try {
      const claim = await verifyLicenseJwt(jwt);
      cachedJwt = jwt;
      cached = { status: "valid", claim };
      return cached;
    } catch (err) {
      // Even on failure we keep the parsed claim if available — useful for
      // the "expired" UI ("hey, your license for X@Y expired 3 days ago").
      const kind: LicenseStatus = err instanceof LicenseError ? err.kind : "invalid";
      const message = err instanceof Error ? err.message : String(err);
      const partialClaim = tryParseClaimUnsafe(jwt);
      cachedJwt = jwt; // Keep on disk; just gated.
      cached = { status: kind, claim: partialClaim, message };
      return cached;
    }
  }

  async function load(): Promise<LicenseStatusReport> {
    return verifyAndCache(await readJwtFile());
  }

  // Eagerly load once on construction. The result populates the cache so
  // synchronous `has()` / `isPro()` calls during module init work.
  let loaded: Promise<void> = load().then(() => {
    if (cached.status === "valid") {
      log.info(`license: loaded ${cached.claim?.sku} (${cached.claim?.email})`);
    } else if (cached.status !== "none") {
      log.warn(`license: ${cached.status} — ${cached.message ?? "no detail"}`);
    }
  });

  return {
    isPro: () => cached.status === "valid",
    has: (feature) => cached.status === "valid" && (cached.claim?.features.includes(feature) ?? false),
    jwt: () => cachedJwt,
    status: () => cached,
    sku: (): LicenseSku | null =>
      cached.status === "valid" ? (cached.claim?.sku ?? null) : null,

    async set(jwt) {
      const result = await verifyAndCache(jwt.trim());
      if (result.status !== "valid") {
        throw new LicenseError(result.status, result.message ?? "License rejected");
      }
      await mkdir(dirname(path), { recursive: true });
      // Atomic write to avoid leaving the file in a half-truncated state on crash.
      const tmp = `${path}.tmp`;
      await writeFile(tmp, jwt.trim() + "\n", "utf-8");
      await chmod(tmp, 0o600);
      await import("node:fs/promises").then((m) => m.rename(tmp, path));
      return result;
    },

    async clear() {
      cachedJwt = null;
      cached = { status: "none" };
      if (existsSync(path)) {
        await unlink(path);
      }
    },

    async refresh() {
      await loaded;
      loaded = load().then(() => {});
      await loaded;
      return cached;
    },
  };
}

/**
 * Best-effort claim parse without signature verification. ONLY used to
 * decorate error states ("your license for X expired") — never trust this
 * for gating; gating goes through verifyLicenseJwt.
 */
function tryParseClaimUnsafe(jwt: string): LicenseClaim | undefined {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return undefined;
    const json = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    return JSON.parse(json) as LicenseClaim;
  } catch {
    return undefined;
  }
}

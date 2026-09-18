/**
 * Protected files — paths that LLM-driven agents and dashboard editors
 * must never overwrite.
 *
 * Two real attack surfaces in Kernl:
 *   1. `kernel_workspace_write` — gives agents file-write power inside their
 *      workspace. If the workspace ever escapes to the kernel root (or a
 *      future workspace points there), this list is the last line of defence.
 *   2. `/api/fs/write` — the dashboard's filesystem editor. A poisoned chat
 *      session that gets the user to click a "fix this" button could try to
 *      land changes that disable tests, leak `.env`, or rewrite CI configs.
 *
 * Inspired by aiden's `PROTECTED_FILES` in core/toolRegistry.ts. Anchored
 * by tail-match (so any path ending in one of these is blocked) plus a
 * fixed extension/glob set for tests and lockfiles. The kernel itself
 * uses other paths (workspaces, /data) where writes ARE legitimate.
 */

// ── Tail-anchored protected paths ───────────────────────────────────────
//
// A write is rejected when the normalized target path ENDS with one of
// these. We use endsWith (not exact match) so `apps/foo/.env` is caught
// alongside `.env`. To allow a specific deeper path, exclude it from the
// list — there is no allow-list override layer by design.

const TAIL_PROTECTED: readonly string[] = [
  // Kernel config & secrets
  ".env",
  ".env.local",
  ".env.production",
  ".env.example",   // committed but acts as a pattern reference

  // Build / dependency manifests
  "package.json",
  "package-lock.json",
  "bun.lockb",
  "tsconfig.json",
  "vitest.config.ts",
  "jest.config.ts",
  "docker-compose.yml",
  "docker-compose.full.yml",
  "Dockerfile",

  // Kernel identity files
  "assets/SOUL.md",
  "CLAUDE.md",
];

// ── Pattern-based protections (extension globs + path fragments) ───────

const PROTECTED_EXTENSIONS: readonly string[] = [
  ".test.ts",   // unit/integration tests — agents must not edit them to "fix" failures
  ".test.tsx",
  ".spec.ts",
  ".spec.tsx",
];

const PROTECTED_FRAGMENTS: readonly string[] = [
  "/.ssh/",
  "/.aws/",
  "/.gnupg/",
  ".github/workflows/",  // CI configs
  "/.git/",              // never overwrite VCS internals
];

const PROTECTED_BASENAMES: readonly string[] = [
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
];

/** Normalize a path for matching: lowercase the drive letter, force forward slashes. */
function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** Result of a protection check — `null` when the write is allowed. */
export interface ProtectionViolation {
  /** Which rule fired (for log lines and audit). */
  rule: "tail" | "extension" | "fragment" | "basename";
  /** The exact protected pattern that matched. */
  pattern: string;
}

/**
 * Check whether a path is protected from writes. Returns `null` when the
 * path is fine, or a `ProtectionViolation` describing the rule that fired.
 *
 * Pure function — no I/O, no state. Callers are responsible for blocking
 * the write and surfacing the violation to the user / audit log.
 */
export function checkProtected(path: string): ProtectionViolation | null {
  const n = normalize(path);
  const lower = n.toLowerCase();

  for (const tail of TAIL_PROTECTED) {
    if (lower.endsWith("/" + tail.toLowerCase()) || lower === tail.toLowerCase()) {
      return { rule: "tail", pattern: tail };
    }
  }
  for (const ext of PROTECTED_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return { rule: "extension", pattern: ext };
    }
  }
  for (const frag of PROTECTED_FRAGMENTS) {
    if (lower.includes(frag)) {
      return { rule: "fragment", pattern: frag };
    }
  }
  // Basenames must match the final segment exactly (with optional .pub suffix).
  const last = lower.split("/").pop() ?? "";
  for (const base of PROTECTED_BASENAMES) {
    if (last === base || last === `${base}.pub`) {
      return { rule: "basename", pattern: base };
    }
  }
  return null;
}

/** Convenience boolean wrapper. */
export function isProtected(path: string): boolean {
  return checkProtected(path) !== null;
}

/**
 * Format a violation for an error message. Keeps the format consistent
 * across the workspace tool, the FS API, and any future caller.
 */
export function formatViolation(path: string, v: ProtectionViolation): string {
  return `Path "${path}" is protected (rule=${v.rule}, pattern="${v.pattern}") — refusing write`;
}

/** Test-only: expose the lists for direct assertion. */
export const _PROTECTED_FOR_TESTS = {
  tails: TAIL_PROTECTED,
  extensions: PROTECTED_EXTENSIONS,
  fragments: PROTECTED_FRAGMENTS,
  basenames: PROTECTED_BASENAMES,
};

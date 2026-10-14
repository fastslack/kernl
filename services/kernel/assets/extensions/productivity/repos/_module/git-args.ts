/**
 * The argv of `kernel_repos_git` and of `kernel_repos_read` at a ref.
 *
 * Every value an agent passes reaches git as its own argv element, but git
 * still reads one that starts with "-" as an option: `ref: "--output=/x"` on a
 * diff wrote a file. So refs are checked against a strict shape (no leading
 * dash, no spaces), and `--end-of-options` goes before them so git stops
 * looking for options there.
 */

export type GitOp = "status" | "diff" | "log" | "branch" | "show";

export interface GitArgsInput {
  op: GitOp;
  /** diff/log/show: a ref or a range (`origin/stable..origin/develop`). */
  ref?: string;
  /** diff/log: limit to this repo-relative path (already jailed by the caller). */
  path?: string;
  /** log: max commits. */
  limit?: number;
  /** log: only commits whose message matches (case-insensitive, fixed string). */
  grep?: string;
  /** diff/show: the patch itself, not just the --stat. */
  patch?: boolean;
}

/** A ref, a range (`a..b`, `a...b`) or `rev:path`; never something git reads as an option. */
const SAFE_REF = /^(?!-)[A-Za-z0-9._/@^~{}:+=-]{1,250}$/;

export function checkRef(ref: string): string | null {
  if (!SAFE_REF.test(ref)) return `invalid ref: ${JSON.stringify(ref)} (letters, digits and . _ / @ ^ ~ { } : + = - only, not starting with -)`;
  if (ref.includes("....")) return `invalid ref: ${JSON.stringify(ref)}`;
  return null;
}

export function gitArgs(a: GitArgsInput): { ok: true; argv: string[] } | { ok: false; error: string } {
  if (a.ref !== undefined && a.ref !== "") {
    const bad = checkRef(a.ref);
    if (bad) return { ok: false, error: bad };
  }
  if (a.grep !== undefined && (a.grep.length > 200 || /[\r\n\0]/.test(a.grep))) {
    return { ok: false, error: "grep: one line, at most 200 characters" };
  }
  const refs = a.ref ? ["--end-of-options", a.ref] : [];
  const path = a.path ? ["--", a.path] : [];
  switch (a.op) {
    case "status":
      return { ok: true, argv: ["status", "--short", "--branch"] };
    case "branch":
      return { ok: true, argv: ["branch", "-a", "--no-color"] };
    case "diff":
      return { ok: true, argv: ["diff", "--no-color", a.patch ? "--stat=200" : "--stat", ...(a.patch ? ["--patch"] : []), ...refs, ...path] };
    case "show":
      return {
        ok: true,
        argv: ["show", "--no-color", a.patch ? "--stat=200" : "--stat", ...(a.patch ? ["--patch"] : []), "--end-of-options", a.ref || "HEAD"],
      };
    case "log": {
      const limit = Math.max(1, Math.min(200, Math.floor(a.limit ?? 20)));
      // --grep's value is part of the same argv element, so it is never an option of its own.
      const grep = a.grep ? ["-i", "--fixed-strings", `--grep=${a.grep}`] : [];
      return { ok: true, argv: ["log", "--oneline", "--decorate", `-${limit}`, ...grep, ...refs, ...path] };
    }
    default:
      return { ok: false, error: `unsupported op: ${String((a as { op: unknown }).op)}` };
  }
}

/** `git show <ref>:<file>`: a file as it is at a ref, not in the working tree. */
export function showFileArgs(ref: string, file: string): { ok: true; argv: string[] } | { ok: false; error: string } {
  const bad = checkRef(ref);
  if (bad) return { ok: false, error: bad };
  if (ref.includes(":")) return { ok: false, error: "ref: a branch, tag or sha, without `:path` (the file goes in `file`)" };
  const rel = file.replace(/^\.?\/+/, "");
  if (!rel || rel.split("/").includes("..") || /[\0\r\n]/.test(rel)) return { ok: false, error: `invalid file: ${file}` };
  return { ok: true, argv: ["show", "--no-color", "--end-of-options", `${ref}:${rel}`] };
}

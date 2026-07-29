import { describe, it, expect } from "bun:test";
import {
  validatePolicy,
  matchSimpleGlob,
  isPathMutable,
  DEFAULT_POLICY,
} from "../assets/extensions/agents/agent-advanced/_module/workspace-evolver/policy.js";
import type { WorkspacePolicy } from "../assets/extensions/agents/agent-advanced/_module/workspace-evolver/types.js";

describe("validatePolicy", () => {
  it("accepts the DEFAULT_POLICY shape", () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
  });

  it("accepts a fully populated valid policy", () => {
    const policy = {
      version: 1,
      mutable_globs: ["src/**/*.ts"],
      protected_globs: ["src/secrets/**"],
      evaluation: { command: "bun test", timeout_s: 60, cwd: "src" },
      budget: { commit_margin: 1.5, max_iterations_per_cycle: 3 },
      constraints: { max_files_changed_per_run: 10, forbidden_packages: ["left-pad"] },
    };
    expect(validatePolicy(policy)).toMatchObject({
      version: 1,
      mutable_globs: ["src/**/*.ts"],
      evaluation: { command: "bun test", timeout_s: 60, cwd: "src" },
      budget: { commit_margin: 1.5, max_iterations_per_cycle: 3 },
      constraints: { forbidden_packages: ["left-pad"] },
    });
  });

  it("rejects missing version", () => {
    expect(validatePolicy({ mutable_globs: [], protected_globs: [], evaluation: { command: "x", timeout_s: 1 } })).toBeNull();
  });

  it("rejects version != 1", () => {
    expect(validatePolicy({ version: 2, mutable_globs: [], protected_globs: [], evaluation: { command: "x", timeout_s: 1 } })).toBeNull();
  });

  it("rejects non-array mutable_globs", () => {
    expect(validatePolicy({ version: 1, mutable_globs: "src/**" as unknown, protected_globs: [], evaluation: { command: "x", timeout_s: 1 } })).toBeNull();
  });

  it("rejects empty evaluation.command", () => {
    expect(validatePolicy({ version: 1, mutable_globs: [], protected_globs: [], evaluation: { command: "", timeout_s: 1 } })).toBeNull();
  });

  it("rejects timeout_s out of range", () => {
    expect(validatePolicy({ version: 1, mutable_globs: [], protected_globs: [], evaluation: { command: "x", timeout_s: 0 } })).toBeNull();
    expect(validatePolicy({ version: 1, mutable_globs: [], protected_globs: [], evaluation: { command: "x", timeout_s: 99999 } })).toBeNull();
  });

  it("rejects null and non-objects", () => {
    expect(validatePolicy(null)).toBeNull();
    expect(validatePolicy("string")).toBeNull();
    expect(validatePolicy([])).toBeNull();
  });

  it("ignores unknown top-level keys silently", () => {
    const result = validatePolicy({
      version: 1,
      mutable_globs: [],
      protected_globs: [],
      evaluation: { command: "ls", timeout_s: 5 },
      bogus_field: "ignored",
    });
    expect(result).not.toBeNull();
    expect((result as unknown as Record<string, unknown>).bogus_field).toBeUndefined();
  });
});

describe("matchSimpleGlob", () => {
  it("matches exact paths", () => {
    expect(matchSimpleGlob("foo.ts", "foo.ts")).toBe(true);
    expect(matchSimpleGlob("foo.ts", "bar.ts")).toBe(false);
  });

  it("* matches one segment", () => {
    expect(matchSimpleGlob("src/foo.ts", "src/*.ts")).toBe(true);
    expect(matchSimpleGlob("src/sub/foo.ts", "src/*.ts")).toBe(false);
  });

  it("** matches any depth", () => {
    expect(matchSimpleGlob("src/foo.ts", "src/**")).toBe(true);
    expect(matchSimpleGlob("src/sub/deep/foo.ts", "src/**")).toBe(true);
    expect(matchSimpleGlob("other/foo.ts", "src/**")).toBe(false);
  });

  it("** in middle works", () => {
    expect(matchSimpleGlob("src/a/b/foo.ts", "src/**/*.ts")).toBe(true);
    expect(matchSimpleGlob("src/foo.ts", "src/**/*.ts")).toBe(true);
  });

  it("escapes regex metachars in literal parts", () => {
    expect(matchSimpleGlob("foo.bar", "foo.bar")).toBe(true);
    expect(matchSimpleGlob("fooXbar", "foo.bar")).toBe(false);
  });
});

describe("isPathMutable", () => {
  const policy: WorkspacePolicy = {
    version: 1,
    mutable_globs: ["src/**/*.ts"],
    protected_globs: ["src/secrets/**"],
    evaluation: { command: "ls", timeout_s: 5 },
  };

  it("blocks globally protected paths regardless of mutable_globs", () => {
    const r = isPathMutable("src/.env", policy);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/global protected-files rule/);
  });

  it("blocks paths matching protected_globs", () => {
    const r = isPathMutable("src/secrets/key.ts", policy);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/protected_globs/);
  });

  it("allows paths in mutable_globs", () => {
    expect(isPathMutable("src/foo/bar.ts", policy).allowed).toBe(true);
  });

  it("blocks paths not in mutable_globs", () => {
    const r = isPathMutable("docs/README.md", policy);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not in policy.mutable_globs/);
  });

  it("empty mutable_globs means allow-everything-except-protected", () => {
    const open: WorkspacePolicy = { ...policy, mutable_globs: [] };
    expect(isPathMutable("anywhere/file.md", open).allowed).toBe(true);
    expect(isPathMutable("src/secrets/key.ts", open).allowed).toBe(false);
  });
});

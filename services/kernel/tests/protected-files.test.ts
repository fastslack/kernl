import { describe, it, expect } from "bun:test";
import { checkProtected, isProtected, formatViolation } from "../src/core/protected-files.js";

describe("protected-files", () => {
  // ── Tail-anchored paths ────────────────────────────────────────

  it("blocks .env at the project root", () => {
    expect(isProtected(".env")).toBe(true);
    expect(isProtected("/home/user/project/.env")).toBe(true);
    expect(checkProtected(".env")?.rule).toBe("tail");
    expect(checkProtected(".env")?.pattern).toBe(".env");
  });

  it("blocks .env in nested directories", () => {
    expect(isProtected("apps/api/.env")).toBe(true);
    expect(isProtected("packages/foo/.env.local")).toBe(true);
  });

  it("blocks lockfiles + manifests", () => {
    expect(isProtected("package.json")).toBe(true);
    expect(isProtected("package-lock.json")).toBe(true);
    expect(isProtected("bun.lockb")).toBe(true);
    expect(isProtected("tsconfig.json")).toBe(true);
    expect(isProtected("vitest.config.ts")).toBe(true);
    expect(isProtected("docker-compose.yml")).toBe(true);
    expect(isProtected("docker-compose.full.yml")).toBe(true);
    expect(isProtected("Dockerfile")).toBe(true);
  });

  it("blocks kernel identity files", () => {
    expect(isProtected("assets/SOUL.md")).toBe(true);
    expect(isProtected("CLAUDE.md")).toBe(true);
  });

  // ── Extension matchers ─────────────────────────────────────────

  it("blocks any *.test.ts / *.spec.ts file (anti-test-tampering)", () => {
    expect(isProtected("tests/foo.test.ts")).toBe(true);
    expect(isProtected("src/modules/chat/service.spec.ts")).toBe(true);
    expect(isProtected("any/path/x.test.tsx")).toBe(true);
    expect(checkProtected("tests/foo.test.ts")?.rule).toBe("extension");
  });

  // ── Path fragments ─────────────────────────────────────────────

  it("blocks SSH / AWS / GnuPG dirs", () => {
    expect(isProtected("/home/user/.ssh/id_rsa")).toBe(true);
    expect(isProtected("/root/.aws/credentials")).toBe(true);
    expect(isProtected("home/.gnupg/secring.gpg")).toBe(true);
  });

  it("blocks GitHub workflows + .git internals", () => {
    expect(isProtected(".github/workflows/ci.yml")).toBe(true);
    expect(isProtected("project/.git/config")).toBe(true);
    expect(checkProtected(".github/workflows/ci.yml")?.rule).toBe("fragment");
  });

  // ── Basenames ──────────────────────────────────────────────────

  it("blocks SSH key basenames + their .pub variants", () => {
    expect(isProtected("/somewhere/id_rsa")).toBe(true);
    expect(isProtected("/somewhere/id_rsa.pub")).toBe(true);
    expect(isProtected("/somewhere/id_ed25519")).toBe(true);
    expect(checkProtected("/somewhere/id_rsa")?.rule).toBe("basename");
  });

  // ── Allowed paths ──────────────────────────────────────────────

  it("allows ordinary source files", () => {
    expect(isProtected("src/index.ts")).toBe(false);
    expect(isProtected("docs/guide.md")).toBe(false);
    expect(isProtected("data/notes/2026-01.md")).toBe(false);
    expect(isProtected("workspace/main/draft.txt")).toBe(false);
  });

  it("allows dashboard files even when name is similar to protected", () => {
    expect(isProtected("dashboard/src/lib/test-helpers.ts")).toBe(false);   // not *.test.ts
    expect(isProtected("dashboard/test-data.json")).toBe(false);            // not test.ts
  });

  it("normalizes Windows-style backslash paths", () => {
    expect(isProtected("C:\\proj\\.env")).toBe(true);
    expect(isProtected("C:\\proj\\src\\index.ts")).toBe(false);
  });

  // ── Format helper ──────────────────────────────────────────────

  it("formatViolation renders a useful one-liner", () => {
    const v = checkProtected(".env")!;
    const msg = formatViolation(".env", v);
    expect(msg).toContain(".env");
    expect(msg).toContain("rule=tail");
    expect(msg).toContain("refusing write");
  });
});

/**
 * Claude Code's model list after a browser sign-in. The catalogue used to be
 * asked only with a pasted setup-token, so a dashboard sign-in fell back to a
 * hardcoded list from the 4.x era and the Chief's picker offered no Opus 5.5.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionAccessToken } from "../src/core/llm/providers/claude-code-provider.js";

function dirWith(creds: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "kernl-cc-session-"));
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify(creds));
  return dir;
}

describe("sessionAccessToken", () => {
  const now = Date.parse("2026-10-08T04:00:00Z");

  it("reads the token the CLI keeps after a browser sign-in", () => {
    const dir = dirWith({ claudeAiOauth: { accessToken: "sk-ant-oat-x", expiresAt: now + 3_600_000 } });
    expect(sessionAccessToken(dir, now)).toBe("sk-ant-oat-x");
  });

  it("does not use a token that is about to expire", () => {
    const dir = dirWith({ claudeAiOauth: { accessToken: "sk-ant-oat-x", expiresAt: now + 30_000 } });
    expect(sessionAccessToken(dir, now)).toBe("");
  });

  it("answers empty without a session or with a malformed file", () => {
    expect(sessionAccessToken(mkdtempSync(join(tmpdir(), "kernl-cc-none-")), now)).toBe("");
    expect(sessionAccessToken(dirWith({ other: 1 }), now)).toBe("");
  });
});

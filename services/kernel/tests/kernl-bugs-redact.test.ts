import { describe, it, expect } from "bun:test";
import { redactForReport, isPrivateTool, normalizeError, bugFingerprint } from "../src/modules/agents/kernl-bugs-redact.js";

describe("redactForReport", () => {
  it.each([
    ["Authorization: Bearer abcdefghijklmnop1234", "Authorization: Bearer ‹redacted›"],
    ["key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV here", "key ‹redacted-key› here"],
    ["token ghp_ABCDEFGHIJKLMNOPQRSTUVWX12 ok", "token ‹redacted-key› ok"],
    ["slack xoxb-1234567890-abcdefghij", "slack ‹redacted-key›"],
    ["google AIzaSyA1234567890abcdefghijklmnopqrstuv", "google ‹redacted-key›"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk", "jwt ‹redacted-jwt›"],
    ["secret 0123456789abcdef0123456789abcdef0123456789", "secret ‹redacted-secret›"],
    ["mail me at maguirre@matware.nl now", "mail me at ‹email› now"],
    ["file /home/fastslack/mtwProjects/x.ts:12", "file ~/mtwProjects/x.ts:12"],
    ["mac /Users/ana/code/y.ts", "mac ~/code/y.ts"],
  ])("%s", (input, out) => {
    expect(redactForReport(input)).toBe(out);
  });
  it("leaves ordinary text alone", () => {
    expect(redactForReport("Reached maximum number of turns (15)")).toBe("Reached maximum number of turns (15)");
  });
});

describe("isPrivateTool", () => {
  it("flags message-content tools, with or without the MCP prefix", () => {
    expect(isPrivateTool("mcp__kernel__kernel_email_search")).toBe(true);
    expect(isPrivateTool("kernel_comms_thread")).toBe(true);
    expect(isPrivateTool("kernel_whatsapp_send")).toBe(true);
    expect(isPrivateTool("kernel_agents_update")).toBe(false);
    expect(isPrivateTool("Bash")).toBe(false);
  });
});

describe("bugFingerprint", () => {
  it("is the same for one failure seen with different ids and numbers", () => {
    const a = bugFingerprint("executor/claude-code", "Run 61756db5-d2bc-45d6-9fa5-10a5581b7112 failed after 15 turns at 2026-10-02T21:32:00Z");
    const b = bugFingerprint("executor/claude-code", "Run 28a2a054-2144-4670-a4c0-e1a89bf3dff0 failed after 40 turns at 2026-10-03T01:02:00Z");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("differs by area and by message", () => {
    expect(bugFingerprint("a", "x")).not.toBe(bugFingerprint("b", "x"));
    expect(bugFingerprint("a", "timeout")).not.toBe(bugFingerprint("a", "auth rejected"));
  });
  it("normalizeError blanks quoted paths too", () => {
    expect(normalizeError(`ENOENT '/app/data/x.json'`)).toBe(normalizeError(`ENOENT '/tmp/y.json'`));
  });
});

describe("redactForReport · review fixes", () => {
  it("redacts fine-grained GitHub tokens and lowercase bearer headers", () => {
    expect(redactForReport("t github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz end")).toBe("t ‹redacted-key› end");
    expect(redactForReport("authorization: bearer abcdefghijklmnop1234")).toBe("authorization: Bearer ‹redacted›");
  });
});

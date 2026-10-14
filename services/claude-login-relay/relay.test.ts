import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingPort, relayCallback } from "./relay.js";

const AUTHORIZE = "https://claude.com/cai/oauth/authorize?code=true&client_id=x"
  + "&redirect_uri=http%3A%2F%2Flocalhost%3A38997%2Fcallback&state=abc123";

describe("pendingPort", () => {
  it("reads the CLI's port off the link of the sign-in waiting", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
    mkdirSync(join(dir, "login-x"));
    writeFileSync(join(dir, "login-x", "authorize-url"), AUTHORIZE + "\n");
    expect(pendingPort(dir)).toBe(38997);
  });

  it("is null with no sign-in, or before the CLI wrote its link", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
    expect(pendingPort(join(dir, "missing"))).toBeNull();
    mkdirSync(join(dir, "login-x"));
    expect(pendingPort(dir)).toBeNull();
  });
});

describe("relayCallback", () => {
  const redirect = "http://localhost:38997/callback?code=C0de&state=abc123";

  it("hands the redirect to the kernel's paste endpoint, with the token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const res = await relayCallback(new Request(redirect), {
      api: "http://127.0.0.1:3086",
      token: () => "T0k",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ state: "waiting", delivered: true });
      }) as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("http://127.0.0.1:3086/api/llm/claude-code/login/callback");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer T0k");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ url: redirect });
  });

  it("says why when the kernel refuses it", async () => {
    const res = await relayCallback(new Request(redirect), {
      api: "http://x",
      token: () => "T",
      fetchImpl: (async () => Response.json({ state: "idle", delivered: false, deliverError: "not_waiting" })) as unknown as typeof fetch,
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("not_waiting");
  });

  it("answers nothing but the callback", async () => {
    const res = await relayCallback(new Request("http://localhost:38997/favicon.ico"), { api: "http://x", token: () => "T" });
    expect(res.status).toBe(404);
  });
});

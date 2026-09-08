import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createClientCredentialsProvider } from "../assets/extensions/ai/mcp-bridge/_module/oauth.js";
import type { McpOAuthConfig } from "../assets/extensions/ai/mcp-bridge/_module/types.js";

const CONFIG: McpOAuthConfig = {
  tokenUrl: "https://example.test/oauth2/token",
  clientId: "cid",
  clientSecret: "csecret",
};

const realFetch = globalThis.fetch;

/** Records every token request and replies with the queued responses in order. */
function stubTokenEndpoint(
  replies: Array<{ status?: number; body: unknown }>,
): { calls: Array<Record<string, string>> } {
  const calls: Array<Record<string, string>> = [];
  let i = 0;

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))));
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return { calls };
}

describe("mcp-bridge OAuth client-credentials provider", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("mints a token with the client_credentials grant", async () => {
    const { calls } = stubTokenEndpoint([
      { body: { access_token: "tok-1", expires_in: 3600 } },
    ]);

    const provider = createClientCredentialsProvider(CONFIG, "test");
    expect(await provider.getToken()).toBe("tok-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].grant_type).toBe("client_credentials");
    expect(calls[0].client_id).toBe("cid");
    expect(calls[0].client_secret).toBe("csecret");
  });

  it("passes scope through only when configured", async () => {
    const { calls } = stubTokenEndpoint([
      { body: { access_token: "tok", expires_in: 3600 } },
    ]);

    await createClientCredentialsProvider(CONFIG, "test").getToken();
    expect(calls[0].scope).toBeUndefined();

    await createClientCredentialsProvider(
      { ...CONFIG, scope: "jobs:read" },
      "test",
    ).getToken();
    expect(calls[1].scope).toBe("jobs:read");
  });

  it("serves a cached token instead of re-minting", async () => {
    const { calls } = stubTokenEndpoint([
      { body: { access_token: "tok-1", expires_in: 3600 } },
    ]);

    const provider = createClientCredentialsProvider(CONFIG, "test");
    await provider.getToken();
    await provider.getToken();
    await provider.getToken();

    expect(calls).toHaveLength(1);
  });

  it("re-mints once the stated lifetime is spent", async () => {
    const { calls } = stubTokenEndpoint([
      { body: { access_token: "tok-1", expires_in: 0 } },
      { body: { access_token: "tok-2", expires_in: 3600 } },
    ]);

    // expires_in: 0 means the token is already dead — honour that instead of
    // caching it for some clamped minimum.
    const provider = createClientCredentialsProvider(CONFIG, "test");
    expect(await provider.getToken()).toBe("tok-1");
    expect(await provider.getToken()).toBe("tok-2");
    expect(calls).toHaveLength(2);
  });

  it("clamps the skew so a token shorter-lived than it is still cached", async () => {
    const { calls } = stubTokenEndpoint([
      { body: { access_token: "tok-1", expires_in: 30 } },
    ]);

    // 30s lifetime against the 60s default skew. Without clamping, the token
    // would sit permanently inside its own refresh window and re-mint on every
    // request; clamped to half the lifetime it stays usable for ~15s.
    const provider = createClientCredentialsProvider(CONFIG, "test");
    expect(await provider.getToken()).toBe("tok-1");
    expect(await provider.getToken()).toBe("tok-1");
    expect(calls).toHaveLength(1);
  });

  it("honours an explicit refreshSkewSeconds", async () => {
    const { calls } = stubTokenEndpoint([
      { body: { access_token: "tok-1", expires_in: 100 } },
      { body: { access_token: "tok-2", expires_in: 100 } },
    ]);

    // Skew wider than the lifetime, clamped to half of it → still cached.
    const provider = createClientCredentialsProvider(
      { ...CONFIG, refreshSkewSeconds: 500 },
      "test",
    );
    expect(await provider.getToken()).toBe("tok-1");
    expect(await provider.getToken()).toBe("tok-1");
    expect(calls).toHaveLength(1);
  });

  it("force discards the cache and mints fresh", async () => {
    const { calls } = stubTokenEndpoint([
      { body: { access_token: "tok-1", expires_in: 3600 } },
      { body: { access_token: "tok-2", expires_in: 3600 } },
    ]);

    const provider = createClientCredentialsProvider(CONFIG, "test");
    expect(await provider.getToken()).toBe("tok-1");
    expect(await provider.getToken(true)).toBe("tok-2");
    expect(calls).toHaveLength(2);
  });

  it("collapses concurrent misses into a single token request", async () => {
    const { calls } = stubTokenEndpoint([
      { body: { access_token: "tok-1", expires_in: 3600 } },
    ]);

    const provider = createClientCredentialsProvider(CONFIG, "test");
    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);

    expect(tokens).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(calls).toHaveLength(1);
  });

  it("throws on a non-OK token response without leaking the secret", async () => {
    stubTokenEndpoint([{ status: 401, body: { error: "invalid_client" } }]);

    const provider = createClientCredentialsProvider(CONFIG, "upwork");
    const err = await provider.getToken().catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("upwork");
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain("csecret");
  });

  it("throws when the endpoint answers 200 with no access_token", async () => {
    stubTokenEndpoint([{ body: { token_type: "Bearer" } }]);

    const provider = createClientCredentialsProvider(CONFIG, "test");
    const err = await provider.getToken().catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("no access_token");
  });

  it("recovers after a failed mint rather than latching the error", async () => {
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt++;
      if (attempt === 1) return new Response("boom", { status: 500 });
      return new Response(
        JSON.stringify({ access_token: "tok-ok", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const provider = createClientCredentialsProvider(CONFIG, "test");
    await expect(provider.getToken()).rejects.toThrow();
    expect(await provider.getToken()).toBe("tok-ok");
  });

  it("still caches when the server omits expires_in", async () => {
    const { calls } = stubTokenEndpoint([{ body: { access_token: "tok-1" } }]);

    const provider = createClientCredentialsProvider(CONFIG, "test");
    await provider.getToken();
    await provider.getToken();

    expect(calls).toHaveLength(1);
  });
});

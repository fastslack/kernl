import { describe, it, expect } from "bun:test";
import {
  discoverHttpServer,
  parseResourceMetadataUrl,
  authorizationServerMetadataUrls,
} from "../assets/extensions/ai/mcp-bridge/_module/discovery.js";

/** Builds a fetch that answers from a URL→response map and records the calls. */
function fakeFetch(routes: Record<string, () => Response>): {
  fn: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("parseResourceMetadataUrl", () => {
  it("pulls the quoted value out of a real Upwork header", () => {
    const header =
      'Bearer error="invalid_token", error_description="The access token is missing or invalid", ' +
      'resource_metadata="https://mcp.upwork.com/.well-known/oauth-protected-resource/mcp"';
    expect(parseResourceMetadataUrl(header)).toBe(
      "https://mcp.upwork.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("accepts an unquoted value", () => {
    expect(parseResourceMetadataUrl("Bearer resource_metadata=https://a.test/meta")).toBe(
      "https://a.test/meta",
    );
  });

  it("returns null when the header is absent or has no pointer", () => {
    expect(parseResourceMetadataUrl(null)).toBeNull();
    expect(parseResourceMetadataUrl('Bearer error="invalid_token"')).toBeNull();
  });
});

describe("authorizationServerMetadataUrls", () => {
  it("tries the origin form for an issuer with no path", () => {
    expect(authorizationServerMetadataUrls("https://mcp.upwork.com")).toContain(
      "https://mcp.upwork.com/.well-known/oauth-authorization-server",
    );
  });

  it("puts the path-suffixed RFC 8414 form first when the issuer has a path", () => {
    const urls = authorizationServerMetadataUrls("https://id.test/tenant");
    expect(urls[0]).toBe("https://id.test/.well-known/oauth-authorization-server/tenant");
    expect(urls).toContain("https://id.test/.well-known/oauth-authorization-server");
  });

  it("returns nothing for a non-URL issuer instead of throwing", () => {
    expect(authorizationServerMetadataUrls("not a url")).toEqual([]);
  });
});

describe("discoverHttpServer", () => {
  it("reports no auth needed when initialize succeeds", async () => {
    const { fn } = fakeFetch({
      "https://open.test/mcp": () => json({ jsonrpc: "2.0", id: 1, result: {} }),
    });
    const r = await discoverHttpServer("https://open.test/mcp", { fetchImpl: fn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.auth_mode).toBe("none");
    expect(r.manual_required).toBe(false);
  });

  // The whole point of the one-field form: this is the exact response chain
  // captured from mcp.upwork.com, replayed offline.
  it("walks the full Upwork chain from a bare URL", async () => {
    const { fn, calls } = fakeFetch({
      "https://mcp.upwork.com/mcp": () =>
        new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer error="invalid_token", error_description="The access token is missing or invalid", ' +
              'resource_metadata="https://mcp.upwork.com/.well-known/oauth-protected-resource/mcp"',
          },
        }),
      "https://mcp.upwork.com/.well-known/oauth-protected-resource/mcp": () =>
        json({
          resource: "https://mcp.upwork.com/mcp",
          authorization_servers: ["https://mcp.upwork.com"],
          bearer_methods_supported: ["header"],
          resource_name: "Upwork MCP",
        }),
      "https://mcp.upwork.com/.well-known/oauth-authorization-server": () =>
        json({
          issuer: "https://mcp.upwork.com",
          authorization_endpoint: "https://www.upwork.com/ab/account-security/oauth2/authorize",
          token_endpoint: "https://www.upwork.com/api/v3/oauth2/token",
          grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
          code_challenge_methods_supported: ["S256"],
        }),
    });

    const r = await discoverHttpServer("https://mcp.upwork.com/mcp", { fetchImpl: fn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.auth_mode).toBe("authorization_code");
    expect(r.resource_name).toBe("Upwork MCP");
    expect(r.authorize_url).toBe("https://www.upwork.com/ab/account-security/oauth2/authorize");
    expect(r.token_url).toBe("https://www.upwork.com/api/v3/oauth2/token");
    expect(r.pkce_s256).toBe(true);
    expect(r.manual_required).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("falls back to manual when the 401 carries no metadata pointer", async () => {
    const { fn } = fakeFetch({
      "https://bare.test/mcp": () =>
        new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="x"' } }),
    });
    const r = await discoverHttpServer("https://bare.test/mcp", { fetchImpl: fn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manual_required).toBe(true);
    expect(r.auth_mode).toBe("authorization_code");
  });

  it("keeps the resource name even when the AS metadata is unreachable", async () => {
    const { fn } = fakeFetch({
      "https://half.test/mcp": () =>
        new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="https://half.test/meta"' },
        }),
      "https://half.test/meta": () =>
        json({ authorization_servers: ["https://half.test"], resource_name: "Half MCP" }),
    });
    const r = await discoverHttpServer("https://half.test/mcp", { fetchImpl: fn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resource_name).toBe("Half MCP");
    expect(r.manual_required).toBe(true);
  });

  it("skips an AS document missing the endpoints and keeps looking", async () => {
    const { fn } = fakeFetch({
      "https://multi.test/mcp": () =>
        new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="https://multi.test/meta"' },
        }),
      "https://multi.test/meta": () => json({ authorization_servers: ["https://multi.test/t1"] }),
      // RFC 8414 form answers but is useless — no endpoints.
      "https://multi.test/.well-known/oauth-authorization-server/t1": () => json({ issuer: "x" }),
      "https://multi.test/.well-known/oauth-authorization-server": () =>
        json({
          authorization_endpoint: "https://multi.test/authorize",
          token_endpoint: "https://multi.test/token",
        }),
    });
    const r = await discoverHttpServer("https://multi.test/mcp", { fetchImpl: fn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token_url).toBe("https://multi.test/token");
    expect(r.pkce_s256).toBe(false);
  });

  it("rejects a malformed URL before touching the network", async () => {
    const { fn, calls } = fakeFetch({});
    const r = await discoverHttpServer("not a url", { fetchImpl: fn });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-http scheme", async () => {
    const r = await discoverHttpServer("ftp://a.test/mcp", { fetchImpl: fakeFetch({}).fn });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("ftp:");
  });

  it("surfaces an unexpected status as a readable error", async () => {
    const { fn } = fakeFetch({
      "https://busted.test/mcp": () => new Response("nope", { status: 500, statusText: "Server Error" }),
    });
    const r = await discoverHttpServer("https://busted.test/mcp", { fetchImpl: fn });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("500");
  });

  it("reports a timeout in words an operator can act on", async () => {
    const hang = (async (_i: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
      })) as unknown as typeof fetch;
    const r = await discoverHttpServer("https://slow.test/mcp", { fetchImpl: hang, timeoutMs: 20 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("The endpoint did not answer in time.");
  });
});

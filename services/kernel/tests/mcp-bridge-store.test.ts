import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { mcpMigrations } from "../assets/extensions/ai/mcp-bridge/_module/migrations/001_mcp.js";
import { McpStore } from "../assets/extensions/ai/mcp-bridge/_module/store.js";
import type { McpServerConfig } from "../assets/extensions/ai/mcp-bridge/_module/types.js";

function freshStore(): McpStore {
  const db = new Database(":memory:");
  runMigrations(db as never, "mcp-bridge", mcpMigrations);
  return new McpStore(db as never);
}

describe("McpStore — servers", () => {
  let store: McpStore;
  beforeEach(() => {
    store = freshStore();
  });

  it("creates an http server and reads it back", () => {
    const s = store.create({ name: "upwork", transport: "http", url: "https://mcp.upwork.com/mcp" });
    expect(s.name).toBe("upwork");
    expect(s.transport).toBe("http");
    expect(s.status).toBe("disabled");
    expect(s.enabled).toBe(true);
    expect(store.get(s.id)?.url).toBe("https://mcp.upwork.com/mcp");
    expect(store.getByName("upwork")?.id).toBe(s.id);
  });

  it("round-trips the JSON columns as real arrays and objects", () => {
    const s = store.create({
      name: "fs",
      transport: "stdio",
      command: "bunx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { FOO: "bar" },
      allow_tools: ["a", "b"],
      deny_tools: ["c"],
      headers: { "X-Trace": "1" },
    });
    const back = store.get(s.id)!;
    expect(back.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(back.env).toEqual({ FOO: "bar" });
    expect(back.allow_tools).toEqual(["a", "b"]);
    expect(back.deny_tools).toEqual(["c"]);
    expect(back.headers).toEqual({ "X-Trace": "1" });
  });

  it("rejects a duplicate name — it would collide the tool prefix", () => {
    store.create({ name: "dup", transport: "http", url: "https://a.test/mcp" });
    expect(() => store.create({ name: "dup", transport: "http", url: "https://b.test/mcp" })).toThrow();
  });

  it("applies a partial update and leaves the rest alone", () => {
    const s = store.create({ name: "n", transport: "http", url: "https://a.test/mcp", allow_tools: ["x"] });
    const updated = store.update(s.id, { url: "https://b.test/mcp" })!;
    expect(updated.url).toBe("https://b.test/mcp");
    expect(updated.allow_tools).toEqual(["x"]);
    expect(updated.name).toBe("n");
  });

  it("update with no keys is a no-op, not a wipe", () => {
    const s = store.create({ name: "n", transport: "http", url: "https://a.test/mcp" });
    expect(store.update(s.id, {})!.url).toBe("https://a.test/mcp");
  });

  it("update on a missing id returns null", () => {
    expect(store.update("nope", { name: "x" })).toBeNull();
  });
});

describe("McpStore — status transitions", () => {
  let store: McpStore;
  beforeEach(() => {
    store = freshStore();
  });

  it("stamps last_connected_at only on connected", () => {
    const s = store.create({ name: "n", transport: "http", url: "https://a.test/mcp" });
    store.setStatus(s.id, "connecting");
    expect(store.get(s.id)!.last_connected_at).toBeNull();
    store.setStatus(s.id, "connected");
    expect(store.get(s.id)!.last_connected_at).not.toBeNull();
  });

  it("keeps last_connected_at after a later failure", () => {
    const s = store.create({ name: "n", transport: "http", url: "https://a.test/mcp" });
    store.setStatus(s.id, "connected");
    const stamp = store.get(s.id)!.last_connected_at;
    store.setStatus(s.id, "failed", "DNS: no such host");
    expect(store.get(s.id)!.last_connected_at).toBe(stamp);
  });

  it("clears a stale error when the server recovers", () => {
    const s = store.create({ name: "n", transport: "http", url: "https://a.test/mcp" });
    store.setStatus(s.id, "failed", "DNS: no such host");
    expect(store.get(s.id)!.last_error).toBe("DNS: no such host");
    store.setStatus(s.id, "connected");
    // A stale message under a healthy status reads as current and sends the
    // operator chasing a problem that is already gone.
    expect(store.get(s.id)!.last_error).toBeNull();
  });

  it("keeps needs_auth and needs_reauth distinct", () => {
    const s = store.create({ name: "n", transport: "http", url: "https://a.test/mcp" });
    store.setStatus(s.id, "needs_auth", "never connected");
    expect(store.get(s.id)!.status).toBe("needs_auth");
    store.setStatus(s.id, "needs_reauth", "token expired");
    expect(store.get(s.id)!.status).toBe("needs_reauth");
    expect(store.get(s.id)!.last_error).toBe("token expired");
  });
});

describe("McpStore — credentials", () => {
  let store: McpStore;
  let id: string;
  beforeEach(() => {
    store = freshStore();
    id = store.create({ name: "n", transport: "http", url: "https://a.test/mcp" }).id;
  });

  it("never returns a secret through the server list", () => {
    store.saveCredentials(id, { access_token: "SECRET", client_secret: "ALSO_SECRET" });
    const serialised = JSON.stringify(store.list());
    expect(serialised).not.toContain("SECRET");
    expect(serialised).not.toContain("ALSO_SECRET");
  });

  it("upserts without dropping the keys it was not given", () => {
    store.saveCredentials(id, { client_id: "cid", client_secret: "csec", token_url: "https://t.test" });
    store.saveCredentials(id, { access_token: "tok" });
    const c = store.getCredentials(id)!;
    expect(c.access_token).toBe("tok");
    expect(c.client_id).toBe("cid");
    expect(c.client_secret).toBe("csec");
    expect(c.token_url).toBe("https://t.test");
  });

  it("clearTokens drops tokens but keeps the client registration", () => {
    store.saveCredentials(id, { access_token: "tok", refresh_token: "ref", client_id: "cid", client_secret: "csec" });
    store.clearTokens(id);
    const c = store.getCredentials(id)!;
    expect(c.access_token).toBeNull();
    expect(c.refresh_token).toBeNull();
    // Re-login must not require re-entering the client registration.
    expect(c.client_id).toBe("cid");
    expect(c.client_secret).toBe("csec");
  });

  it("removing a server takes its credentials and tools with it", () => {
    store.saveCredentials(id, { access_token: "tok" });
    store.replaceTools(id, [{ name: "mcp_n_a" }]);
    expect(store.remove(id)).toBe(true);
    expect(store.get(id)).toBeNull();
    expect(store.getCredentials(id)).toBeNull();
    expect(store.listTools(id)).toHaveLength(0);
  });
});

describe("McpStore — tool cache", () => {
  let store: McpStore;
  let id: string;
  beforeEach(() => {
    store = freshStore();
    id = store.create({ name: "n", transport: "http", url: "https://a.test/mcp" }).id;
  });

  it("replaces wholesale so a removed tool disappears", () => {
    store.replaceTools(id, [{ name: "mcp_n_a" }, { name: "mcp_n_b" }]);
    expect(store.countTools(id)).toBe(2);
    store.replaceTools(id, [{ name: "mcp_n_a" }]);
    expect(store.listTools(id).map((t) => t.name)).toEqual(["mcp_n_a"]);
  });

  it("keeps descriptions and sorts by name", () => {
    store.replaceTools(id, [
      { name: "mcp_n_z", description: "last" },
      { name: "mcp_n_a", description: "first" },
    ]);
    const tools = store.listTools(id);
    expect(tools.map((t) => t.name)).toEqual(["mcp_n_a", "mcp_n_z"]);
    expect(tools[0].description).toBe("first");
  });
});

describe("McpStore — OAuth state", () => {
  let store: McpStore;
  let id: string;
  beforeEach(() => {
    store = freshStore();
    id = store.create({ name: "n", transport: "http", url: "https://a.test/mcp" }).id;
  });

  it("consumes a state exactly once", () => {
    store.saveOAuthState({ state: "st", server_id: id, code_verifier: "ver", redirect_uri: "http://localhost/cb" });
    expect(store.consumeOAuthState("st")?.code_verifier).toBe("ver");
    // A replayed callback must not buy a second token exchange.
    expect(store.consumeOAuthState("st")).toBeNull();
  });

  it("refuses an expired state and sweeps it", () => {
    store.saveOAuthState({
      state: "old",
      server_id: id,
      code_verifier: "ver",
      redirect_uri: "http://localhost/cb",
      ttlSeconds: -1,
    });
    expect(store.consumeOAuthState("old")).toBeNull();
  });

  it("returns null for an unknown state", () => {
    expect(store.consumeOAuthState("never-issued")).toBeNull();
  });
});

describe("McpStore — env import", () => {
  let store: McpStore;
  beforeEach(() => {
    store = freshStore();
  });

  const CONFIGS: McpServerConfig[] = [
    {
      name: "upwork",
      type: "http",
      url: "https://mcp.upwork.com/mcp",
      oauth: { tokenUrl: "https://t.test/token", clientId: "cid", clientSecret: "csec" },
    },
    {
      name: "fs",
      type: "stdio",
      command: "bunx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  ];

  it("imports both transports and maps the auth mode", () => {
    expect(store.importFromEnv(CONFIGS).sort()).toEqual(["fs", "upwork"]);
    expect(store.getByName("upwork")!.auth_mode).toBe("client_credentials");
    expect(store.getByName("fs")!.auth_mode).toBe("none");
    expect(store.getByName("fs")!.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
  });

  it("moves the env credentials into the credential table", () => {
    store.importFromEnv(CONFIGS);
    const c = store.getCredentials(store.getByName("upwork")!.id)!;
    expect(c.client_id).toBe("cid");
    expect(c.client_secret).toBe("csec");
    expect(c.token_url).toBe("https://t.test/token");
  });

  it("maps a static token to auth_mode token", () => {
    store.importFromEnv([{ name: "api", type: "http", url: "https://a.test/mcp", token: "tok" }]);
    expect(store.getByName("api")!.auth_mode).toBe("token");
    expect(store.getCredentials(store.getByName("api")!.id)!.access_token).toBe("tok");
  });

  it("imports only into an empty table", () => {
    store.importFromEnv(CONFIGS);
    // An operator who deletes an imported server must not get it resurrected on
    // the next boot by an env var they forgot to clear.
    store.remove(store.getByName("fs")!.id);
    expect(store.importFromEnv(CONFIGS)).toEqual([]);
    expect(store.getByName("fs")).toBeNull();
  });
});

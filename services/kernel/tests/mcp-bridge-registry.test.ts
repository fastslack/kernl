import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { runMigrations } from "../src/core/db/migrations.js";
import { mcpMigrations } from "../assets/extensions/ai/mcp-bridge/_module/migrations/001_mcp.js";
import { McpStore } from "../assets/extensions/ai/mcp-bridge/_module/store.js";
import { McpRegistry } from "../assets/extensions/ai/mcp-bridge/_module/registry.js";
import { ReauthRequiredError } from "../assets/extensions/ai/mcp-bridge/_module/oauth.js";
import type { McpBridgeConnection } from "../assets/extensions/ai/mcp-bridge/_module/client.js";
import type { ToolDefinition } from "../src/core/types.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `desc ${name}`,
    inputSchema: z.any(),
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  } as ToolDefinition;
}

function fakeConnection(serverName: string, toolNames: string[]): McpBridgeConnection {
  return {
    serverName,
    tools: toolNames.map(tool),
    disconnect: async () => {},
  };
}

function harness(connect: (cfg: any) => Promise<McpBridgeConnection>) {
  const db = new Database(":memory:");
  runMigrations(db as never, "mcp-bridge", mcpMigrations);
  const store = new McpStore(db as never);
  let republishCount = 0;
  const registry = new McpRegistry({
    store,
    republish: () => { republishCount += 1; },
    connect: connect as never,
  });
  return { store, registry, republished: () => republishCount };
}

describe("McpRegistry — connecting", () => {
  it("connects, caches the tools and reports them", async () => {
    const { store, registry } = harness(async () => fakeConnection("fs", ["mcp_fs_read", "mcp_fs_write"]));
    const s = store.create({ name: "fs", transport: "stdio", command: "bunx" });

    await registry.connect(s.id);

    expect(store.get(s.id)!.status).toBe("connected");
    expect(registry.getTools().map((t) => t.name)).toEqual(["mcp_fs_read", "mcp_fs_write"]);
    expect(store.listTools(s.id).map((t) => t.name)).toEqual(["mcp_fs_read", "mcp_fs_write"]);
    expect(store.get(s.id)!.last_connected_at).not.toBeNull();
  });

  // This is the test that keeps hot reconnection alive: without a republish the
  // chat and agent catalogs keep whatever they converted at boot.
  it("republishes the tool surface after connecting", async () => {
    const { store, registry, republished } = harness(async () => fakeConnection("fs", ["mcp_fs_read"]));
    const s = store.create({ name: "fs", transport: "stdio", command: "bunx" });
    const before = republished();
    await registry.connect(s.id);
    expect(republished()).toBeGreaterThan(before);
  });

  it("republishes after disconnecting too", async () => {
    const { store, registry, republished } = harness(async () => fakeConnection("fs", ["mcp_fs_read"]));
    const s = store.create({ name: "fs", transport: "stdio", command: "bunx" });
    await registry.connect(s.id);
    const before = republished();
    await registry.disconnect(s.id);
    expect(republished()).toBeGreaterThan(before);
    expect(registry.getTools()).toHaveLength(0);
  });

  it("replaces the tool set on reconnect instead of accumulating", async () => {
    let names = ["mcp_fs_a", "mcp_fs_b"];
    const { store, registry } = harness(async () => fakeConnection("fs", names));
    const s = store.create({ name: "fs", transport: "stdio", command: "bunx" });

    await registry.connect(s.id);
    expect(registry.getTools()).toHaveLength(2);

    names = ["mcp_fs_a"];
    await registry.connect(s.id);
    expect(registry.getTools().map((t) => t.name)).toEqual(["mcp_fs_a"]);
    expect(store.listTools(s.id)).toHaveLength(1);
  });

  it("skips a disabled server and marks it so", async () => {
    let called = false;
    const { store, registry } = harness(async () => {
      called = true;
      return fakeConnection("fs", []);
    });
    const s = store.create({ name: "fs", transport: "stdio", command: "bunx", enabled: false });
    await registry.connect(s.id);
    expect(called).toBe(false);
    expect(store.get(s.id)!.status).toBe("disabled");
  });

  it("returns null for an unknown server", async () => {
    const { registry } = harness(async () => fakeConnection("x", []));
    expect(await registry.connect("nope")).toBeNull();
  });
});

describe("McpRegistry — failure states", () => {
  it("records a transport failure as failed, with the message", async () => {
    const { store, registry } = harness(async () => {
      throw new Error("getaddrinfo ENOTFOUND linear.test");
    });
    const s = store.create({ name: "linear", transport: "http", url: "https://linear.test/mcp" });
    await registry.connect(s.id);
    const row = store.get(s.id)!;
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("ENOTFOUND");
  });

  it("a 401 with no stored token means needs_auth, not needs_reauth", async () => {
    const { store, registry } = harness(async () => {
      throw new Error("HTTP 401 Unauthorized");
    });
    const s = store.create({ name: "upwork", transport: "http", url: "https://mcp.upwork.test/mcp" });
    await registry.connect(s.id);
    expect(store.get(s.id)!.status).toBe("needs_auth");
  });

  it("a 401 with a stored token means the token died", async () => {
    const { store, registry } = harness(async () => {
      throw new Error("HTTP 401 Unauthorized");
    });
    const s = store.create({ name: "upwork", transport: "http", url: "https://mcp.upwork.test/mcp" });
    store.saveCredentials(s.id, { access_token: "stale" });
    await registry.connect(s.id);
    expect(store.get(s.id)!.status).toBe("needs_reauth");
    expect(store.get(s.id)!.last_error).toContain("rejected");
  });

  it("propagates ReauthRequiredError as an auth state", async () => {
    const { store, registry } = harness(async () => {
      throw new ReauthRequiredError("upwork", "no refresh token stored");
    });
    const s = store.create({ name: "upwork", transport: "http", url: "https://mcp.upwork.test/mcp" });
    await registry.connect(s.id);
    expect(store.get(s.id)!.status).toBe("needs_auth");
  });

  it("keeps a failed server out of the tool surface", async () => {
    const { store, registry } = harness(async () => {
      throw new Error("boom");
    });
    const s = store.create({ name: "x", transport: "http", url: "https://x.test/mcp" });
    await registry.connect(s.id);
    expect(registry.getTools()).toHaveLength(0);
    expect(registry.isConnected(s.id)).toBe(false);
  });

  it("authorization_code without a client registration asks for auth, not a crash", async () => {
    const { store, registry } = harness(async () => fakeConnection("upwork", []));
    const s = store.create({
      name: "upwork",
      transport: "http",
      url: "https://mcp.upwork.test/mcp",
      auth_mode: "authorization_code",
    });
    await registry.connect(s.id);
    expect(store.get(s.id)!.status).toBe("needs_auth");
  });
});

describe("McpRegistry — lifecycle", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness(async (cfg: any) => fakeConnection(cfg.name, [`mcp_${cfg.name}_a`]));
  });

  it("connectAll brings up every enabled server and republishes once", async () => {
    h.store.create({ name: "a", transport: "stdio", command: "x" });
    h.store.create({ name: "b", transport: "stdio", command: "x" });
    h.store.create({ name: "c", transport: "stdio", command: "x", enabled: false });

    await h.registry.connectAll();

    expect(h.registry.getTools().map((t) => t.name).sort()).toEqual(["mcp_a_a", "mcp_b_a"]);
    expect(h.store.getByName("c")!.status).toBe("disabled");
  });

  it("disable disconnects and survives credentials", async () => {
    const s = h.store.create({ name: "a", transport: "stdio", command: "x" });
    h.store.saveCredentials(s.id, { refresh_token: "keep-me" });
    await h.registry.connect(s.id);
    await h.registry.disable(s.id);

    expect(h.store.get(s.id)!.enabled).toBe(false);
    expect(h.store.get(s.id)!.status).toBe("disabled");
    expect(h.registry.getTools()).toHaveLength(0);
    expect(h.store.getCredentials(s.id)!.refresh_token).toBe("keep-me");
  });

  it("remove takes the row, the tools and the connection", async () => {
    const s = h.store.create({ name: "a", transport: "stdio", command: "x" });
    await h.registry.connect(s.id);
    expect(await h.registry.remove(s.id)).toBe(true);
    expect(h.store.get(s.id)).toBeNull();
    expect(h.registry.getTools()).toHaveLength(0);
  });

  it("shutdown closes everything", async () => {
    h.store.create({ name: "a", transport: "stdio", command: "x" });
    h.store.create({ name: "b", transport: "stdio", command: "x" });
    await h.registry.connectAll();
    await h.registry.shutdown();
    expect(h.registry.getTools()).toHaveLength(0);
  });

  it("connecting twice does not double-register the tools", async () => {
    const s = h.store.create({ name: "a", transport: "stdio", command: "x" });
    await h.registry.connect(s.id);
    await h.registry.connect(s.id);
    expect(h.registry.getTools()).toHaveLength(1);
  });
});

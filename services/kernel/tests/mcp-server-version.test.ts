import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModuleRegistry } from "../src/core/module-registry.js";
import { createMcpServer } from "../src/server.js";

const emptyRegistry = {
  getAllTools: () => [],
  getAllResourceProviders: () => [],
} as unknown as ModuleRegistry;

describe("MCP server identity", () => {
  it("reports the version in package.json to connecting clients", async () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf-8"));
    const server = createMcpServer(emptyRegistry, undefined, { enableTasks: false });
    const client = new Client({ name: "version-test", version: "1.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      expect(client.getServerVersion()).toEqual({ name: "kernl", version: pkg.version });
    } finally {
      await client.close();
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { toolMemoryMigrations } from "../src/modules/tool-memory/migrations.js";
import { ToolMemoryService } from "../src/modules/tool-memory/service.js";
import type { EmbeddingsClient } from "../src/core/embeddings/index.js";

/**
 * Mock embeddings: deterministic, identity-on-input, so we can assert
 * exact similarity without spinning up a real model.
 *
 * Strategy: hash the input text into 16 floats (4-byte chunks of djb2),
 * normalised. Same string → same vector → cosine 1. Different strings
 * → mostly orthogonal vectors → cosine ≈ 0.
 */
const mockEmbeddings: EmbeddingsClient = {
  provider: "local",
  model: "mock",
  dim: 16,
  async available() { return true; },
  async embed(texts) {
    return texts.map((t) => embedDjb2(t));
  },
};

function embedDjb2(s: string): number[] {
  const out = new Array<number>(16).fill(0);
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
    out[i % 16] += h;
  }
  // L2-normalise so cosine == dot product later.
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return out.map((v) => v / norm);
}

let db: Database;
let svc: ToolMemoryService;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, "tool-memory", toolMemoryMigrations);
  svc = new ToolMemoryService(db, mockEmbeddings);
});

describe("toolMemoryMigrations", () => {
  test("runMigrations creates the tool_memory table", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_memory'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("tool_memory");
  });
});

afterEach(() => {
  db.close();
});

describe("ToolMemoryService", () => {
  test("indexed call is retrievable by exact similarity", async () => {
    await svc.record({
      tool: "kernel_send_email",
      input: { to: "alice@example.com", subject: "hi" },
      output: { id: "msg_1" },
      ownerAgentId: "agent_a",
    });
    const results = await svc.findSimilar({
      tool: "kernel_send_email",
      input: { to: "alice@example.com", subject: "hi" },
      ownerAgentId: "agent_a",
      minSimilarity: 0.99,
    });
    expect(results).toHaveLength(1);
    expect(results[0].similarity).toBeGreaterThan(0.99);
  });

  test("different args produce dissimilar embeddings", async () => {
    await svc.record({
      tool: "kernel_send_email",
      input: { to: "alice@example.com" },
      output: {},
      ownerAgentId: "agent_a",
    });
    const results = await svc.findSimilar({
      tool: "kernel_send_email",
      input: { to: "totally-different-zzz@example.com" },
      ownerAgentId: "agent_a",
      minSimilarity: 0.95,
    });
    expect(results).toHaveLength(0);
  });

  test("memory is partitioned by owner_agent_id", async () => {
    await svc.record({
      tool: "kernel_send_email",
      input: { to: "alice@example.com" },
      output: {},
      ownerAgentId: "agent_a",
    });
    const cross = await svc.findSimilar({
      tool: "kernel_send_email",
      input: { to: "alice@example.com" },
      ownerAgentId: "agent_b",
      minSimilarity: 0,
    });
    expect(cross).toHaveLength(0);
  });

  test("falls back to broader search when same-tool history is sparse", async () => {
    // Index a single call under a different tool name.
    await svc.record({
      tool: "kernel_other_tool",
      input: { hello: "world" },
      output: {},
      ownerAgentId: "agent_a",
    });
    // Searching by an unindexed tool returns the cross-tool match
    // because same-tool candidates < 5. Threshold is loose because
    // tool name is part of the embedded summary; with the mock djb2
    // embedding even the cross-tool match scores low.
    const results = await svc.findSimilar({
      tool: "kernel_unknown_tool",
      input: { hello: "world" },
      ownerAgentId: "agent_a",
      minSimilarity: 0,
    });
    expect(results.length).toBeGreaterThan(0);
  });

  test("purge deletes all rows for an owner", async () => {
    for (let i = 0; i < 3; i++) {
      await svc.record({
        tool: "kernel_demo",
        input: { i },
        output: {},
        ownerAgentId: "agent_a",
      });
    }
    expect(svc.purge("agent_a")).toBe(3);
    expect(svc.export("agent_a")).toHaveLength(0);
  });

  test("export returns all rows minus the embedding blob", async () => {
    await svc.record({
      tool: "kernel_demo",
      input: { x: 1 },
      output: { ok: true },
      ownerAgentId: "agent_a",
    });
    const rows = svc.export("agent_a");
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("kernel_demo");
    expect(rows[0].input_json).toContain("x");
    expect(rows[0]).not.toHaveProperty("embedding");
  });

  test("similarity threshold filters out weak matches", async () => {
    await svc.record({
      tool: "kernel_demo",
      input: { topic: "alpha" },
      output: {},
      ownerAgentId: "agent_a",
    });
    const results = await svc.findSimilar({
      tool: "kernel_demo",
      input: { topic: "completely-different-omega-zzz" },
      ownerAgentId: "agent_a",
      minSimilarity: 0.99,
    });
    expect(results).toHaveLength(0);
  });
});

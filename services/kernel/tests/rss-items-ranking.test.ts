import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { EventBus } from "../src/core/event-bus.js";
import { rssRegistryMigrations } from "../assets/extensions/integration/rss-registry/_module/migrations.js";
import { RssRegistryService } from "../assets/extensions/integration/rss-registry/_module/service.js";
import { rssRegistryTools } from "../assets/extensions/integration/rss-registry/_module/tools.js";
import type { EmbeddingsClient } from "../src/core/embeddings/client.js";
import type { ToolDefinition } from "../src/core/types.js";

function countWord(s: string, w: string): number {
  return (s.toLowerCase().match(new RegExp(w, "g")) || []).length;
}
const fakeEmbeddings: EmbeddingsClient = {
  provider: "local",
  model: "fake",
  dim: 2,
  async available() {
    return true;
  },
  async embed(texts: string[]) {
    return texts.map((t) => [countWord(t, "alpha"), countWord(t, "beta")]);
  },
};

interface Seed {
  title: string;
  description: string;
}

// Ordered newest-first by insertion. The most-alpha item is the OLDEST, and
// the newest items are beta-only. So a naive "ORDER BY recency LIMIT k" path
// would surface beta and never the alpha item — only real relevance ranking
// (which must widen the candidate set beyond k) can surface "alpha alpha alpha".
const ITEMS: Seed[] = [
  { title: "beta beta beta", description: "beta digest" }, // newest
  { title: "beta beta", description: "beta brief" },
  { title: "beta", description: "beta note" },
  { title: "gamma report", description: "unrelated content" },
  // alpha-heavy but tilted toward beta in vector space — should rank below
  // the pure-alpha item under cosine, AND below it under lexical (fewer alphas).
  { title: "alpha alpha", description: "beta aside beta" },
  // oldest, purest + most alpha-heavy → must be the top result either way.
  { title: "alpha alpha alpha", description: "alpha story" },
];

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

async function callText(t: ToolDefinition, args: unknown): Promise<string> {
  const res = await t.handler(args);
  // ToolResult: { content: [{ type: "text", text }] }
  const part = (res as { content: Array<{ text?: string }> }).content[0];
  return part?.text ?? "";
}

function fresh(embeddings: EmbeddingsClient | null) {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(
    db as unknown as Parameters<typeof runMigrations>[0],
    "rss-registry",
    rssRegistryMigrations,
  );
  const events = new EventBus();
  const service = new RssRegistryService(
    db as unknown as ConstructorParameters<typeof RssRegistryService>[0],
    events,
    embeddings,
  );

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO rss_registry (id, name, slug, feed_url, created_at, updated_at)
     VALUES ('feed1', 'Feed One', 'feed-one', 'http://x/feed.xml', ?, ?)`,
    [now, now],
  );
  ITEMS.forEach((it, idx) => {
    db.run(
      `INSERT INTO rss_items (id, feed_id, guid, title, description, fetched_at, hash, published_at)
       VALUES (?, 'feed1', ?, ?, ?, ?, ?, ?)`,
      [
        `item${idx}`,
        `guid${idx}`,
        it.title,
        it.description,
        now,
        `hash${idx}`,
        // descending published so no-query order is deterministic (item0 newest)
        new Date(Date.now() - idx * 1000).toISOString(),
      ],
    );
  });

  const tools = rssRegistryTools(service);
  return { db, service, items: tool(tools, "kernel_rss_items") };
}

describe("kernel_rss_items ranking", () => {
  let env: ReturnType<typeof fresh>;

  beforeEach(() => {
    env = fresh(fakeEmbeddings);
  });

  it("caps to top-k and ranks by relevance when a query is given", async () => {
    const text = await callText(env.items, { query: "alpha", limit: 3 });
    // header reports the returned count
    const header = text.match(/## Items \((\d+)\)/);
    expect(header).not.toBeNull();
    expect(Number(header![1])).toBeLessThanOrEqual(3);

    // top result is the most alpha-heavy item
    const firstBullet = text.split("\n").find((l) => l.startsWith("- "));
    expect(firstBullet).toContain("alpha alpha alpha");

    // beta-only items must NOT survive an alpha-only top-3
    expect(text).not.toContain("beta beta beta");
  });

  it("regression: no query returns the full list unchanged", async () => {
    const noQuery = await callText(env.items, {});
    const header = noQuery.match(/## Items \((\d+)\)/);
    expect(header).not.toBeNull();
    // all 6 seeded items present (pre-existing behavior)
    expect(Number(header![1])).toBe(ITEMS.length);
  });

  it("degrades to lexical top-k when no embeddings client is wired", async () => {
    const e = fresh(null);
    const text = await callText(e.items, { query: "alpha", limit: 3 });
    const header = text.match(/## Items \((\d+)\)/);
    expect(Number(header![1])).toBeLessThanOrEqual(3);
    const firstBullet = text.split("\n").find((l) => l.startsWith("- "));
    expect(firstBullet).toContain("alpha alpha alpha");
  });
});

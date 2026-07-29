import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { chatMigrations } from "../src/modules/chat/migrations/001_chat.js";
import { EventBus } from "../src/core/event-bus.js";
import { MemoryDistiller } from "../src/modules/chat/memory-distiller.js";
import type { LlmClient, LlmChatOptions, LlmChatResult } from "../src/core/llm/client.js";

/** Minimal LlmClient stub — controls the distiller's perception of LLM output. */
function fakeLlm(scriptedReturn: string | (() => string | Promise<string>)): LlmClient {
  return {
    async chat(_opts: LlmChatOptions): Promise<LlmChatResult> {
      const text = typeof scriptedReturn === "function" ? await scriptedReturn() : scriptedReturn;
      return { text, model: "fake", provider: "openai" };
    },
  } as unknown as LlmClient;
}

describe("MemoryDistiller", () => {
  let db: InstanceType<typeof Database>;
  let bus: EventBus;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db as unknown as never, "chat", chatMigrations);
    bus = new EventBus();
    // Register a fake chat_episodes row so FK constraints don't bite
    db.prepare(
      `INSERT INTO chat_episodes (id, title, summary, status, message_count,
        llm_provider, llm_model, total_tokens, created_at, updated_at)
        VALUES (?, '', '', 'archived', 6, '', '', 0, datetime('now'), datetime('now'))`,
    ).run("ep-1");
  });

  it("inserts well-formed facts into chat_distilled_facts", async () => {
    const llm = fakeLlm(JSON.stringify([
      { category: "preference", fact: "User prefers concise responses in Spanish", confidence: 0.9 },
      { category: "fact",       fact: "User runs a small e-commerce business",     confidence: 0.7 },
      { category: "decision",   fact: "Will use Anthropic as the primary LLM",     confidence: 0.85 },
    ]));
    const distiller = new MemoryDistiller(db as unknown as never, bus, llm);

    const result = await distiller.handleSessionStop({
      episodeId: "ep-1",
      messageCount: 6,
      transcript: "USER: hola...\n".repeat(20),
      reason: "explicit-close",
    });

    expect(result.length).toBe(3);
    const rows = distiller.listForEpisode("ep-1");
    expect(rows.length).toBe(3);
    const cats = rows.map(r => r.category).sort();
    expect(cats).toEqual(["decision", "fact", "preference"]);
  });

  it("clamps confidence to [0,1]", async () => {
    const llm = fakeLlm(JSON.stringify([
      { fact: "Out-of-range high", confidence: 5.0 },
      { fact: "Out-of-range low",  confidence: -1.0 },
    ]));
    const distiller = new MemoryDistiller(db as unknown as never, bus, llm);
    const result = await distiller.handleSessionStop({
      episodeId: "ep-1",
      messageCount: 6,
      transcript: "x".repeat(300),
      reason: "explicit-close",
    });
    expect(result[0].confidence).toBe(1);
    expect(result[1].confidence).toBe(0);
  });

  it("defaults missing/non-numeric confidence to 0.5", async () => {
    const llm = fakeLlm(JSON.stringify([
      { fact: "no confidence field" },
      { fact: "garbage confidence", confidence: "not-a-number" },
    ]));
    const distiller = new MemoryDistiller(db as unknown as never, bus, llm);
    const result = await distiller.handleSessionStop({
      episodeId: "ep-1",
      messageCount: 6,
      transcript: "x".repeat(300),
      reason: "explicit-close",
    });
    expect(result[0].confidence).toBe(0.5);
    expect(result[1].confidence).toBe(0.5);
  });

  it("strips markdown fences around JSON", async () => {
    const llm = fakeLlm("```json\n[{\"fact\":\"Wrapped fact\",\"confidence\":0.8}]\n```");
    const distiller = new MemoryDistiller(db as unknown as never, bus, llm);
    const result = await distiller.handleSessionStop({
      episodeId: "ep-1",
      messageCount: 6,
      transcript: "x".repeat(300),
      reason: "explicit-close",
    });
    expect(result.length).toBe(1);
    expect(result[0].fact).toBe("Wrapped fact");
  });

  it("skips short / empty episodes (< MIN_MESSAGES)", async () => {
    const llm = fakeLlm("[{\"fact\":\"should-not-persist\"}]");
    const distiller = new MemoryDistiller(db as unknown as never, bus, llm);
    const result = await distiller.handleSessionStop({
      episodeId: "ep-1",
      messageCount: 2,           // below MIN_MESSAGES (4)
      transcript: "x".repeat(300),
      reason: "explicit-close",
    });
    expect(result).toEqual([]);
    expect(distiller.listForEpisode("ep-1")).toEqual([]);
  });

  it("returns [] when LLM emits non-JSON", async () => {
    const llm = fakeLlm("I don't think there's anything to distill here, sorry!");
    const distiller = new MemoryDistiller(db as unknown as never, bus, llm);
    const result = await distiller.handleSessionStop({
      episodeId: "ep-1",
      messageCount: 6,
      transcript: "x".repeat(300),
      reason: "explicit-close",
    });
    expect(result).toEqual([]);
  });

  it("returns [] when LLM throws", async () => {
    const llm = fakeLlm(() => { throw new Error("network down"); });
    const distiller = new MemoryDistiller(db as unknown as never, bus, llm);
    const result = await distiller.handleSessionStop({
      episodeId: "ep-1",
      messageCount: 6,
      transcript: "x".repeat(300),
      reason: "explicit-close",
    });
    expect(result).toEqual([]);
  });

  it("attach() registers a listener on chat.session_stop", async () => {
    const llm = fakeLlm(JSON.stringify([{ fact: "wired-up-fact", confidence: 0.9 }]));
    const distiller = new MemoryDistiller(db as unknown as never, bus, llm);
    distiller.attach();

    await bus.emit("chat.session_stop", {
      episodeId: "ep-1",
      messageCount: 6,
      transcript: "x".repeat(300),
      reason: "explicit-close",
    });

    const rows = distiller.listForEpisode("ep-1");
    expect(rows.length).toBe(1);
    expect(rows[0].fact).toBe("wired-up-fact");
  });

  it("emits data.changed after persisting", async () => {
    const llm = fakeLlm(JSON.stringify([{ fact: "test", confidence: 0.5 }]));
    const distiller = new MemoryDistiller(db as unknown as never, bus, llm);

    type ChangedShape = { module?: string; action?: string; count?: number };
    const seen: ChangedShape[] = [];
    bus.on("data.changed", (p) => { seen.push(p as ChangedShape); });

    await distiller.handleSessionStop({
      episodeId: "ep-1",
      messageCount: 6,
      transcript: "x".repeat(300),
      reason: "explicit-close",
    });

    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1];
    expect(last.module).toBe("chat");
    expect(last.action).toBe("distilled");
    expect(last.count).toBe(1);
  });

  it("caps insertions at MAX_FACTS even if LLM returns more", async () => {
    const lots = Array.from({ length: 50 }, (_, i) => ({ fact: `fact-${i}`, confidence: 0.5 }));
    const llm = fakeLlm(JSON.stringify(lots));
    const distiller = new MemoryDistiller(db as unknown as never, bus, llm);
    const result = await distiller.handleSessionStop({
      episodeId: "ep-1",
      messageCount: 6,
      transcript: "x".repeat(300),
      reason: "explicit-close",
    });
    expect(result.length).toBe(25);
  });

  it("search() filters by category", async () => {
    db.prepare(
      `INSERT INTO chat_distilled_facts (id, episode_id, category, fact, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run("a", "ep-1", "preference", "uses dark mode", 0.9);
    db.prepare(
      `INSERT INTO chat_distilled_facts (id, episode_id, category, fact, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run("b", "ep-1", "fact", "lives in Buenos Aires", 0.8);

    const distiller = new MemoryDistiller(db as unknown as never, bus, fakeLlm("[]"));
    expect(distiller.search("preference").length).toBe(1);
    expect(distiller.search("fact").length).toBe(1);
    expect(distiller.search(null).length).toBe(2);
  });

  // Backs GET /api/chat/distilled-facts/episode and the per-episode panel
  // on the /memory dashboard page.
  it("listForEpisode() returns rows sorted by confidence DESC", () => {
    const insert = db.prepare(
      `INSERT INTO chat_distilled_facts (id, episode_id, category, fact, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    );
    insert.run("a", "ep-1", "fact", "low",  0.3);
    insert.run("b", "ep-1", "fact", "high", 0.95);
    insert.run("c", "ep-1", "fact", "mid",  0.6);
    insert.run("z", "ep-other", "fact", "other-episode", 0.99);

    const distiller = new MemoryDistiller(db as unknown as never, bus, fakeLlm("[]"));
    const rows = distiller.listForEpisode("ep-1");
    expect(rows.length).toBe(3);
    expect(rows.map(r => r.fact)).toEqual(["high", "mid", "low"]);
  });

  // Backs GET /api/chat/distilled-facts (limit query string).
  it("search() respects the limit cap", () => {
    const insert = db.prepare(
      `INSERT INTO chat_distilled_facts (id, episode_id, category, fact, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    );
    for (let i = 0; i < 30; i++) {
      insert.run(`id-${i}`, "ep-1", "fact", `fact ${i}`, 0.5);
    }
    const distiller = new MemoryDistiller(db as unknown as never, bus, fakeLlm("[]"));
    expect(distiller.search(null, 10).length).toBe(10);
    expect(distiller.search(null, 100).length).toBe(30);
  });

  // Smokes the row shape the /api/chat/distilled-facts/summary endpoint
  // buckets in the handler. The handler does the grouping; this test just
  // ensures the underlying search() call returns mixed-category rows
  // (different categories must coexist for the buckets to be non-trivial).
  it("backs summary endpoint: search(null) returns rows from all categories", () => {
    const insert = db.prepare(
      `INSERT INTO chat_distilled_facts (id, episode_id, category, fact, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    );
    insert.run("a", "ep-1", "preference", "p1", 0.9);
    insert.run("b", "ep-1", "preference", "p2", 0.7);
    insert.run("c", "ep-1", "fact",       "f1", 0.6);
    insert.run("d", "ep-1", "decision",   "d1", 0.8);

    const distiller = new MemoryDistiller(db as unknown as never, bus, fakeLlm("[]"));
    const all = distiller.search(null, 500);
    expect(all.length).toBe(4);
    const categories = new Set(all.map(r => r.category));
    expect(categories.has("preference")).toBe(true);
    expect(categories.has("fact")).toBe(true);
    expect(categories.has("decision")).toBe(true);
  });

  // ── formatForPrompt: closes the recall loop ────────────────────────
  // These exercise the bridge that puts distilled facts back into the
  // next chat turn's system prompt. Without it the memory is write-only.

  describe("formatForPrompt", () => {
    function seed(insert: { run: (...args: unknown[]) => unknown }) {
      insert.run("a", "ep-1", "preference", "Prefers concise answers", 0.95);
      insert.run("b", "ep-1", "preference", "Speaks Spanish",          0.9);
      insert.run("c", "ep-1", "fact",       "Lives in Buenos Aires",   0.85);
      insert.run("d", "ep-1", "decision",   "Anthropic = primary",     0.8);
      insert.run("e", "ep-1", "fact",       "Works at Acme Corp",      0.7);
    }

    it("returns empty string when there are no facts", () => {
      const distiller = new MemoryDistiller(db as unknown as never, bus, fakeLlm("[]"));
      expect(distiller.formatForPrompt()).toBe("");
    });

    it("returns empty string when limit is 0 (recall disabled)", () => {
      const insert = db.prepare(
        `INSERT INTO chat_distilled_facts (id, episode_id, category, fact, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      );
      seed(insert);
      const distiller = new MemoryDistiller(db as unknown as never, bus, fakeLlm("[]"));
      expect(distiller.formatForPrompt(0)).toBe("");
    });

    it("groups facts by category with stable ordering", () => {
      const insert = db.prepare(
        `INSERT INTO chat_distilled_facts (id, episode_id, category, fact, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      );
      seed(insert);
      const distiller = new MemoryDistiller(db as unknown as never, bus, fakeLlm("[]"));
      const out = distiller.formatForPrompt(10);

      // Header is stable
      expect(out).toContain("## What you remember about the user");
      // Categories appear as section headers
      expect(out).toContain("### preference");
      expect(out).toContain("### fact");
      expect(out).toContain("### decision");
      // Facts rendered as bullets
      expect(out).toContain("- Prefers concise answers");
      expect(out).toContain("- Lives in Buenos Aires");
      // Largest category (preference, 2 facts) appears before smaller ones
      expect(out.indexOf("### preference")).toBeLessThan(out.indexOf("### decision"));
    });

    it("respects limit cap (highest-confidence first)", () => {
      const insert = db.prepare(
        `INSERT INTO chat_distilled_facts (id, episode_id, category, fact, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      );
      seed(insert);
      const distiller = new MemoryDistiller(db as unknown as never, bus, fakeLlm("[]"));
      const out = distiller.formatForPrompt(2);
      // Only the two highest-confidence facts should be present
      expect(out).toContain("Prefers concise answers");  // 0.95
      expect(out).toContain("Speaks Spanish");           // 0.9
      // Lower-confidence ones are dropped
      expect(out).not.toContain("Works at Acme Corp");   // 0.7
      expect(out).not.toContain("Anthropic = primary");  // 0.8
    });

    it("instructs the model not to parrot facts back verbatim", () => {
      const insert = db.prepare(
        `INSERT INTO chat_distilled_facts (id, episode_id, category, fact, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      );
      seed(insert);
      const distiller = new MemoryDistiller(db as unknown as never, bus, fakeLlm("[]"));
      const out = distiller.formatForPrompt();
      expect(out).toContain("Never repeat them back verbatim unless asked");
    });
  });
});

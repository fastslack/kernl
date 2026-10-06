/**
 * Where a chat came from: the v5 backfill of `source`/`source_label`, the
 * cleanup of the 3D panel's warmup pings, resuming a surface's episode, and a
 * warmup turn that leaves nothing behind.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { chatMigrations } from "../src/modules/chat/migrations/001_chat.js";
import { ChatService } from "../src/modules/chat/service.js";
import { EventBus } from "../src/core/event-bus.js";
import type { KernelConfig } from "../src/core/config.js";

const PING = 'Ping. Respond with exactly the word "ready" and nothing else.';

function stubConfig(): KernelConfig {
  return JSON.parse(JSON.stringify({
    language: "en",
    timezone: "UTC",
    agents: { defaultProvider: "", defaultModel: "", defaultModelChain: [] },
    claudeCode: {},
    chat: { defaultProvider: "claude-code", defaultModel: "", systemPrompt: "", maxEpisodeMessages: 200, contextBudget: 8000 },
  })) as KernelConfig;
}

function makeService(db: Database) {
  return new ChatService(db as unknown as never, () => null, new EventBus(), stubConfig());
}

/** Schema as it stood before v5, with rows the old surfaces wrote. */
function legacyDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db as unknown as never, "chat", chatMigrations.filter((m) => m.version < 5));
  const ep = db.prepare(
    `INSERT INTO chat_episodes (id, title, message_count, llm_provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const msg = db.prepare(
    `INSERT INTO chat_messages (id, episode_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const fts = db.prepare("INSERT INTO chat_messages_fts (message_id, content) VALUES (?, ?)");
  const say = (id: string, ep: string, role: string, content: string, at: string) => {
    msg.run(id, ep, role, content, at);
    fts.run(id, content);
  };

  // 3D, only the warmup.
  ep.run("e-ping", "Chief (chat)", 2, "claude_code", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z");
  say("m1", "e-ping", "user", PING, "2026-10-01T00:00:01Z");
  say("m2", "e-ping", "assistant", "ready", "2026-10-01T00:00:02Z");

  // 3D, warmup then a real exchange.
  ep.run("e-real", "Chief (chat)", 4, "claude_code", "2026-10-02T00:00:00Z", "2026-10-02T00:00:00Z");
  say("m3", "e-real", "user", PING, "2026-10-02T00:00:01Z");
  say("m4", "e-real", "assistant", "ready", "2026-10-02T00:00:02Z");
  say("m5", "e-real", "user", "how many agents failed today in the research office?", "2026-10-02T00:01:00Z");
  say("m6", "e-real", "assistant", "None.", "2026-10-02T00:01:05Z");

  ep.run("e-setup", "Mesa de Investigación — first run", 0, "claude-code", "2026-10-03T00:00:00Z", "2026-10-03T00:00:00Z");
  ep.run("e-tg", "telegram 12345", 0, "claude-code", "2026-10-03T00:00:00Z", "2026-10-03T00:00:00Z");
  ep.run("e-dash", "hola que modelo eres?", 2, "openai", "2026-10-03T00:00:00Z", "2026-10-03T00:00:00Z");
  return db;
}

describe("chat migration v5", () => {
  const db = legacyDb();
  runMigrations(db as unknown as never, "chat", chatMigrations);
  const row = (id: string) =>
    db.prepare("SELECT title, source, source_label, message_count FROM chat_episodes WHERE id = ?").get(id) as
      { title: string; source: string; source_label: string; message_count: number } | null;

  it("derives the source from the title each surface stamped", () => {
    expect(row("e-real")).toMatchObject({ source: "office3d", source_label: "Chief" });
    expect(row("e-setup")).toMatchObject({ source: "setup", source_label: "Mesa de Investigación" });
    expect(row("e-tg")).toMatchObject({ source: "platform", source_label: "telegram" });
    expect(row("e-dash")).toMatchObject({ source: "dashboard", source_label: "", title: "hola que modelo eres?" });
  });

  it("drops warmup pings with their reply, and 3D episodes left empty", () => {
    expect(row("e-ping")).toBeNull();
    const left = db.prepare("SELECT id FROM chat_messages ORDER BY id").all() as { id: string }[];
    expect(left.map((m) => m.id)).toEqual(["m5", "m6"]);
    const fts = db.prepare("SELECT message_id FROM chat_messages_fts ORDER BY message_id").all() as { message_id: string }[];
    expect(fts.map((m) => m.message_id)).toEqual(["m5", "m6"]);
    expect(row("e-real")?.message_count).toBe(2);
  });

  it("retitles 3D episodes from their first real message", () => {
    expect(row("e-real")?.title).toBe("how many agents failed today in the research office?");
  });
});

describe("ChatService episode source", () => {
  function fresh() {
    const db = new Database(":memory:");
    runMigrations(db as unknown as never, "chat", chatMigrations);
    return makeService(db);
  }

  it("stores the source, falling back to dashboard for unknown values", () => {
    const svc = fresh();
    expect(svc.createEpisode({ provider: "openai", source: "mcp" }).source).toBe("mcp");
    const odd = svc.createEpisode({ provider: "openai", source: "nope" });
    expect(svc.getEpisode(odd.id)?.source).toBe("dashboard");
  });

  it("resumes the latest matching surface episode across provider spellings", () => {
    const svc = fresh();
    const first = svc.resumeOrCreateEpisode({
      provider: "claude_code", source: "office3d", source_label: "Chief", instructions: "v1",
    });
    expect(first.resumed).toBe(false);
    const again = svc.resumeOrCreateEpisode({
      provider: "claude-code", source: "office3d", source_label: "Chief", instructions: "v2",
    });
    expect(again.resumed).toBe(true);
    expect(again.id).toBe(first.id);
    expect(svc.getEpisode(first.id)?.instructions).toBe("v2");
  });

  it("opens a new episode for another agent or model", () => {
    const svc = fresh();
    const chief = svc.resumeOrCreateEpisode({ provider: "claude_code", source: "office3d", source_label: "Chief" });
    const other = svc.resumeOrCreateEpisode({ provider: "claude_code", source: "office3d", source_label: "Boss" });
    const opus = svc.resumeOrCreateEpisode({
      provider: "claude_code", model: "claude-opus-5-5", source: "office3d", source_label: "Chief",
    });
    expect(new Set([chief.id, other.id, opus.id]).size).toBe(3);
  });

  it("a warmup turn stores nothing and keeps the SDK session", async () => {
    const db = new Database(":memory:");
    runMigrations(db as unknown as never, "chat", chatMigrations);
    const svc = makeService(db);
    const ep = svc.createEpisode({ provider: "claude-code", source: "office3d" });
    db.prepare("UPDATE chat_episodes SET sdk_session_id = 'keep-me' WHERE id = ?").run(ep.id);

    const seen: { sessionId?: string }[] = [];
    const fake = {
      name: "claude-code",
      available: () => true,
      async chatCompletionStream(_msg: string, sink: (ev: unknown) => void, opts: { sessionId?: string }) {
        seen.push(opts);
        sink({ type: "session", session_id: "throwaway" });
        sink({ type: "assistant_text", text: "ready" });
        return { finalText: "ready", tokensUsed: 3, sessionId: "throwaway" };
      },
    };
    (svc as unknown as { providers: Map<string, unknown> }).providers = new Map([["claude-code", fake]]);

    const events: { type: string }[] = [];
    await svc.chatStream(ep.id, PING, (ev) => events.push(ev), { warmup: true });

    expect(seen[0].sessionId).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["done"]);
    const after = svc.getEpisode(ep.id)!;
    expect(after.message_count).toBe(0);
    expect(after.sdk_session_id).toBe("keep-me");
    expect(after.title).toBe("");
  });
});

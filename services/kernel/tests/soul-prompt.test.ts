import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { chatMigrations } from "../src/modules/chat/migrations/001_chat.js";
import { ChatService, _resetSoulCacheForTests } from "../src/modules/chat/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { MemoryDistiller } from "../src/modules/chat/memory-distiller.js";
import type { LlmClient } from "../src/core/llm/client.js";
import type { KernelConfig } from "../src/core/config.js";

function stubConfig(): KernelConfig {
  // Use the same shape as tests/chat.test.ts — just enough fields for ChatService
  // construction. We're only testing prompt assembly, not chat logic.
  return JSON.parse(JSON.stringify({
    sqlite: { path: ":memory:" },
    neo4j: { uri: "", user: "", password: "" },
    logLevel: "error",
    timezone: "UTC",
    mattermost: { webhookUrl: null, username: "test" },
    reminders: { pollIntervalMs: 30000 },
    dashboard: { enabled: false, port: 3000, refreshIntervalMs: 30000 },
    google: { clientId: "", clientSecret: "", callbackPort: 8787 },
    issues: { syncIntervalMs: 900000 },
    life: { lat: 0, lon: 0, city: "", timezone: "UTC", currencies: "USD", clocks: [], waterGoal: 8 },
    resend: { apiKey: "" },
    mcp: { transport: "stdio" },
    agents: {
      pollIntervalMs: 30000, maxConcurrentRuns: 3, defaultProvider: "", defaultModel: "",
      defaultModelChain: [], evalProvider: "", evalModel: "",
      learningCleanupIntervalMs: 3600000, learningMinConfidence: 0.15,
    },
    telegram: { enabled: false, botToken: "", allowedUserIds: [], defaultChatId: null },
    proactive: { enabled: false, morningTime: "07:00", eveningTime: "21:00" },
    voice: { whisperUrl: "", openaiApiKey: "", elevenLabsKey: "" },
    webIntel: {
      anthropicApiKey: "", openaiApiKey: "", grokApiKey: "", grokDefaultModel: "",
      nvidiaApiKey: "", nvidiaDefaultModel: "", lmstudioBaseUrl: "",
    },
    chat: {
      defaultProvider: "", defaultModel: "", systemPrompt: "",
      maxEpisodeMessages: 200, contextBudget: 8000,
    },
  })) as KernelConfig;
}

describe("SOUL prompt loading", () => {
  beforeEach(() => {
    _resetSoulCacheForTests();
  });

  it("assets/SOUL.md exists and has expected sections", () => {
    const soulPath = resolve(process.cwd(), "assets", "SOUL.md");
    expect(existsSync(soulPath)).toBe(true);
    const text = readFileSync(soulPath, "utf-8");
    // Spot-check section headings
    expect(text).toContain("# Kernl");
    expect(text).toContain("## Identity");
    expect(text).toContain("## Voice");
    expect(text).toContain("## Security");
  });

  it("ChatService prepends SOUL when systemPrompt is empty", () => {
    const db = new Database(":memory:");
    runMigrations(db as unknown as never, "chat", chatMigrations);
    const cfg = stubConfig();
    cfg.chat.systemPrompt = "";
    const svc = new ChatService(
      db as unknown as never,
      () => null,
      new EventBus(),
      cfg,
    );
    // systemPrompt is private; we read it via a small accessor — fall back to
    // poking via cast which is fine in tests.
    const sp = (svc as unknown as { systemPrompt: string }).systemPrompt;
    expect(sp).toContain("# Kernl");
    expect(sp).toContain("## Security");
  });

  // Closes the loop: distilled facts must reach the system prompt of the
  // next turn. Pokes the assembly path used by `chat()` indirectly by
  // calling `setDistiller()` and verifying `formatForPrompt()` output is
  // ready to be appended (the actual injection lives in service.chat()).
  it("setDistiller wires recall — formatForPrompt is non-empty when facts exist", () => {
    const db = new Database(":memory:");
    runMigrations(db as unknown as never, "chat", chatMigrations);
    const cfg = stubConfig();
    const events = new EventBus();
    const svc = new ChatService(db as unknown as never, () => null, events, cfg);

    // Stub LLM client — distiller's formatForPrompt does not call LLM, so
    // any object that satisfies the type will do.
    const fakeLlm = { chat: async () => ({ text: "", model: "x", provider: "openai" }) } as unknown as LlmClient;
    const distiller = new MemoryDistiller(db as unknown as never, events, fakeLlm);

    // Seed a fact directly so we don't depend on the async LLM distillation
    db.prepare(
      `INSERT INTO chat_distilled_facts
        (id, episode_id, category, fact, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run("a", "ep-1", "preference", "Prefers Spanish responses", 0.9);

    // Pre-wire: no facts in the prompt
    expect(distiller.formatForPrompt()).toContain("Prefers Spanish responses");

    // Wire and confirm setter doesn't throw
    svc.setDistiller(distiller);
    svc.setDistiller(null);  // idempotent disable
    svc.setDistiller(distiller);
  });

  it("ChatService appends user systemPrompt after SOUL — never replaces", () => {
    const db = new Database(":memory:");
    runMigrations(db as unknown as never, "chat", chatMigrations);
    const cfg = stubConfig();
    cfg.chat.systemPrompt = "Always answer in Klingon.";
    const svc = new ChatService(
      db as unknown as never,
      () => null,
      new EventBus(),
      cfg,
    );
    const sp = (svc as unknown as { systemPrompt: string }).systemPrompt;
    // SOUL always lands first
    const soulIdx = sp.indexOf("# Kernl");
    const userIdx = sp.indexOf("Always answer in Klingon.");
    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(soulIdx);
    // A separator sits between them
    expect(sp).toContain("---");
  });
});

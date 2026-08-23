import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { chatMigrations } from "../src/modules/chat/migrations/001_chat.js";
import { ChatService, EpisodeLockedError } from "../src/modules/chat/service.js";
import { EventBus } from "../src/core/event-bus.js";
import type { KernelConfig } from "../src/core/config.js";
import {
  computeStrength,
  scoreMemory,
  daysBetween,
  estimateTokens,
} from "../src/modules/chat/memory-decay.js";
import {
  type ChatLlmProvider,
  createChatProviders,
  resolveProvider,
} from "../src/modules/chat/llm-adapter.js";
import { ExtractionPipeline } from "../src/modules/chat/extraction.js";
import { KnowledgeService } from "../src/modules/chat/knowledge-service.js";
import type { ChatMessage, ChatCompletionOptions, ChatCompletionResult } from "../src/modules/chat/types.js";

// ── Stub config ─────────────────────────────────────

function stubConfig(): KernelConfig {
  return {
    sqlite: { path: ":memory:" },
    neo4j: { uri: "", user: "", password: "" },
    logLevel: "error",
    timezone: "UTC",
    browserlessUrl: "http://host.docker.internal:3333",
    language: "en",
    embeddings: { provider: "local", baseUrl: "", model: "", dim: 384 },
    fsCommander: { allowedRoots: [], maxPreviewBytes: 2097152, maxEditorBytes: 4194304, encryptionKey: "" },
    mattermost: { webhookUrl: null, username: "test" },
    reminders: { pollIntervalMs: 30000 },
    dashboard: { enabled: false, port: 3000, bind: "127.0.0.1", refreshIntervalMs: 30000 },
    google: { clientId: "", clientSecret: "", callbackPort: 8787 },
    issues: { syncIntervalMs: 900000 },
    life: {
      lat: 52.3676,
      lon: 4.9041,
      city: "Amsterdam",
      timezone: "Europe/Amsterdam",
      currencies: "USD",
      clocks: [],
      waterGoal: 8,
    },
    resend: { apiKey: "" },
    mcp: { transport: "stdio" },
    agents: { pollIntervalMs: 30000, maxConcurrentRuns: 3, minScheduleSeconds: 300, internalApiPort: 3087, defaultProvider: "", defaultModel: "", defaultModelChain: [], evalProvider: "", evalModel: "", learningCleanupIntervalMs: 3600000, learningMinConfidence: 0.15, maxInvokeDepth: 5, autoPauseThreshold: 3, invokeTimeoutMs: 300000, inboxWakeQuietMs: 300000, subscriptionCooldownMs: 60000, useSemanticRanking: false, semanticRankingCosineWeight: 0.7, semanticRankingMinScore: 0.30 },
    telegram: { enabled: false, botToken: "", allowedUserIds: [], defaultChatId: null },
    proactive: { enabled: false, morningTime: "07:00", eveningTime: "21:00" },
    channels: {
      whatsapp: { enabled: false, authPath: "", allowedNumbers: [] },
      slack: { enabled: false, botToken: "", appToken: "", allowedUsers: [], allowedChannels: [] },
      discord: { enabled: false, botToken: "", allowedUsers: [], allowedGuilds: [], allowedChannels: [] },
      webchat: { enabled: false, requireAuth: false },
    },
    voice: { enabled: false, sttProvider: "openai" as const, ttsProvider: "system" as const, openaiApiKey: "", elevenLabsApiKey: "", localWhisperPath: "", defaultVoiceId: "alloy", respondWithVoice: false },
    pii: { enabled: false, redactEmails: false, redactPhones: false, redactCreditCards: false, redactIbans: false, redactNames: false, warnOnSend: false, placeholder: "[REDACTED]" },
    ibkr: { gatewayUrl: "https://localhost:5000", accountId: "", enabled: false },
    saxo: { baseUrl: "", appKey: "", appSecret: "", certPath: "", certKeyPath: "", enabled: false },
    encryption: { key: "" },
    auth: { token: "" },
    claudeCode: { mcpUrl: "http://localhost:3087/mcp", mcpBridgePath: "", mcpTransport: "stdio", cliPath: "", model: "" },
    cors: { allowedOrigins: [] },
    bridge: { enabled: false, socketPath: "/tmp/kernl.sock" },
    rustBridge: { enabled: false, socketPath: "/tmp/mtw-rust.sock" },
    webIntel: {
      pollIntervalMs: 60000,
      defaultLlm: "claude",
      anthropicApiKey: "",
      openaiApiKey: "",
      grokApiKey: "",
      grokDefaultModel: "",
      nvidiaApiKey: "",
      nvidiaDefaultModel: "",
      lmstudioBaseUrl: "",
      braveApiKey: "",
      googleCseKey: "",
      googleCseCx: "",
      searxngBaseUrl: "",
    },
    chat: {
      defaultProvider: "stub",
      defaultModel: "stub-model",
      extractionModel: "",
      contextBudget: 2000,
      maxEpisodeMessages: 100,
      decayIntervalMs: 3600000,
      patternDetectionIntervalMs: 86400000,
      systemPrompt: "You are a test assistant.",
    },
    store: { autoUpdate: true },
  };
}

// ── Memory Decay (pure functions) ───────────────────

describe("memory-decay", () => {
  describe("computeStrength", () => {
    it("returns 1.0 for zero days elapsed", () => {
      expect(computeStrength(0, 0)).toBe(1.0);
    });

    it("decays over time without reinforcement", () => {
      const s7 = computeStrength(7, 0);
      // e^(-7/7) = e^(-1) ≈ 0.368
      expect(s7).toBeCloseTo(Math.exp(-1), 3);
    });

    it("decays slower with reinforcements", () => {
      const noReinforce = computeStrength(7, 0);
      const withReinforce = computeStrength(7, 4);
      expect(withReinforce).toBeGreaterThan(noReinforce);
    });

    it("approaches zero for very old unreinforced memories", () => {
      const s90 = computeStrength(90, 0);
      expect(s90).toBeLessThan(0.001);
    });

    it("heavily reinforced memories stay strong", () => {
      // 10 reinforcements: stability = 7 * (1 + 0.5*10) = 42 days
      // e^(-30/42) ≈ 0.49
      const s30 = computeStrength(30, 10);
      expect(s30).toBeGreaterThan(0.4);
    });
  });

  describe("scoreMemory", () => {
    it("combines similarity and strength", () => {
      const score = scoreMemory(0.8, 0.6, false);
      expect(score).toBeCloseTo(0.48, 3);
    });

    it("boosts current episode memories", () => {
      const normal = scoreMemory(0.8, 0.6, false);
      const boosted = scoreMemory(0.8, 0.6, true);
      expect(boosted).toBeGreaterThan(normal);
      expect(boosted).toBeCloseTo(0.72, 3);
    });
  });

  describe("daysBetween", () => {
    it("calculates days between dates", () => {
      const days = daysBetween("2024-01-01T00:00:00Z", "2024-01-08T00:00:00Z");
      expect(days).toBeCloseTo(7, 1);
    });
  });

  describe("estimateTokens", () => {
    it("estimates tokens from text", () => {
      const tokens = estimateTokens("Hello world this is a test");
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(20);
    });

    it("returns 0 for empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });
  });
});

// ── LLM Adapter ─────────────────────────────────────

describe("llm-adapter", () => {
  it("creates providers from config", () => {
    const providers = createChatProviders({
      anthropicApiKey: "sk-test",
      openaiApiKey: "sk-openai",
      lmstudioBaseUrl: "http://localhost:1234/v1",
    });
    // claude, claude_code + claude-code alias (same instance), openai,
    // lmstudio, grok, nvidia, minimax
    expect(providers.size).toBe(8);
    expect(providers.get("claude")?.available()).toBe(true);
    expect(providers.get("openai")?.available()).toBe(true);
    expect(providers.get("lmstudio")?.available()).toBe(true);
    expect(providers.get("claude_code")).toBe(providers.get("claude-code")!);
  });

  it("reports unavailable when no key", () => {
    const providers = createChatProviders({
      anthropicApiKey: "",
      openaiApiKey: "",
      lmstudioBaseUrl: "",
    });
    expect(providers.get("claude")?.available()).toBe(false);
    expect(providers.get("openai")?.available()).toBe(false);
    expect(providers.get("lmstudio")?.available()).toBe(false);
  });

  it("resolveProvider falls back when requested unavailable", () => {
    const providers = createChatProviders({
      anthropicApiKey: "",
      openaiApiKey: "",
      lmstudioBaseUrl: "",
      grokApiKey: "xai-test",
      minimaxApiKey: "",
    });
    // claude_code availability depends on the local CLI — force it off so the
    // test behaves the same on dev machines and CI runners.
    (providers.get("claude_code") as { available: () => boolean }).available = () => false;
    const provider = resolveProvider(providers, "claude");
    expect(provider?.name).toBe("grok");
  });

  it("resolveProvider uses non-canonical providers as leftover fallback", () => {
    // openai is out of FALLBACK_ORDER, but step 3 (leftover scan) still picks
    // it up when nothing canonical is available.
    const providers = createChatProviders({
      anthropicApiKey: "",
      openaiApiKey: "sk-openai",
      lmstudioBaseUrl: "",
      minimaxApiKey: "",
    });
    (providers.get("claude_code") as { available: () => boolean }).available = () => false;
    expect(resolveProvider(providers, "claude")?.name).toBe("openai");
  });

  it("resolveProvider returns null when none available", () => {
    const providers = createChatProviders({
      anthropicApiKey: "",
      openaiApiKey: "",
      lmstudioBaseUrl: "",
      minimaxApiKey: "",
    });
    (providers.get("claude_code") as { available: () => boolean }).available = () => false;
    expect(resolveProvider(providers, "claude")).toBeNull();
  });
});

// ── ChatService CRUD ────────────────────────────────

describe("ChatService", () => {
  let db: InstanceType<typeof Database>;
  let service: ChatService;
  let events: EventBus;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "chat", chatMigrations);
    events = new EventBus();
    service = new ChatService(
      db,
      () => null,
      events,
      stubConfig(),
    );
  });
  afterEach(() => db.close());

  // ── Episodes ──────────────────────────────────────

  describe("episodes", () => {
    it("creates an episode", () => {
      const ep = service.createEpisode({ title: "Test Chat" });
      expect(ep.id).toBeTruthy();
      expect(ep.title).toBe("Test Chat");
      expect(ep.status).toBe("active");
      expect(ep.message_count).toBe(0);
    });

    it("creates episode with provider/model", () => {
      const ep = service.createEpisode({
        provider: "openai",
        model: "gpt-4o",
      });
      expect(ep.llm_provider).toBe("openai");
      expect(ep.llm_model).toBe("gpt-4o");
    });

    it("uses defaults when no provider/model specified", () => {
      const ep = service.createEpisode({});
      expect(ep.llm_provider).toBe("stub");
      expect(ep.llm_model).toBe("stub-model");
    });

    it("gets episode by id", () => {
      const ep = service.createEpisode({ title: "Findable" });
      const found = service.getEpisode(ep.id);
      expect(found?.title).toBe("Findable");
    });

    it("returns undefined for missing episode", () => {
      expect(service.getEpisode("nonexistent")).toBeFalsy();
    });

    it("lists episodes", () => {
      service.createEpisode({ title: "First" });
      service.createEpisode({ title: "Second" });
      const episodes = service.listEpisodes();
      expect(episodes).toHaveLength(2);
    });

    it("lists episodes filtered by status", () => {
      const ep1 = service.createEpisode({ title: "Active" });
      const ep2 = service.createEpisode({ title: "To Archive" });
      service.archiveEpisode(ep2.id);

      const active = service.listEpisodes({ status: "active" });
      expect(active).toHaveLength(1);
      expect(active[0].title).toBe("Active");

      const archived = service.listEpisodes({ status: "archived" });
      expect(archived).toHaveLength(1);
      expect(archived[0].title).toBe("To Archive");
    });

    it("archives an episode", () => {
      const ep = service.createEpisode({ title: "To Archive" });
      const archived = service.archiveEpisode(ep.id);
      expect(archived?.status).toBe("archived");
    });

    it("returns undefined when archiving nonexistent episode", () => {
      expect(service.archiveEpisode("nonexistent")).toBeFalsy();
    });

    // ── Model lock ──────────────────────────────────
    // The model an episode answers with is fixed by its first message: the
    // transcript above a switch was produced by a different model, so a
    // mid-conversation swap makes the history a lie. The dashboard hides the
    // picker once a chat starts; this is the rule the UI can't be trusted with.

    it("switches provider while the episode has no messages", () => {
      const ep = service.createEpisode({ provider: "openai", model: "gpt-4o" });
      const updated = service.updateEpisodeProvider(ep.id, "openai", "gpt-4o-mini");
      expect(updated?.llm_model).toBe("gpt-4o-mini");
    });

    it("refuses to switch provider once the episode has messages", () => {
      const ep = service.createEpisode({ provider: "openai", model: "gpt-4o" });
      db.prepare("UPDATE chat_episodes SET message_count = 2 WHERE id = ?").run(ep.id);

      expect(() => service.updateEpisodeProvider(ep.id, "grok", "grok-4-fast-non-reasoning"))
        .toThrow(EpisodeLockedError);
      expect(service.getEpisode(ep.id)?.llm_provider).toBe("openai");
      expect(service.getEpisode(ep.id)?.llm_model).toBe("gpt-4o");
    });
  });

  // ── Messages ──────────────────────────────────────

  describe("messages", () => {
    it("getMessages returns empty for new episode", () => {
      const ep = service.createEpisode({});
      expect(service.getMessages(ep.id)).toHaveLength(0);
    });

    it("searchMessages returns results via FTS", () => {
      const ep = service.createEpisode({});
      // Store messages manually via chat (which requires LLM) — so use direct SQL
      db.prepare(
        `INSERT INTO chat_messages (id, episode_id, role, content, token_count, context_used, extraction_data, created_at)
         VALUES ('m1', ?, 'user', 'quantum computing is fascinating', 5, '{}', '{}', datetime('now'))`,
      ).run(ep.id);
      db.prepare(
        "INSERT INTO chat_messages_fts (message_id, content) VALUES ('m1', 'quantum computing is fascinating')",
      ).run();

      const results = service.searchMessages("quantum");
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("quantum");
    });

    it("searchMessages returns empty for no match", () => {
      expect(service.searchMessages("nonexistent")).toHaveLength(0);
    });
  });

  // ── Extractions ───────────────────────────────────

  describe("extractions", () => {
    it("stores and retrieves extractions", () => {
      const ep = service.createEpisode({});
      // Create a message first
      db.prepare(
        `INSERT INTO chat_messages (id, episode_id, role, content, token_count, context_used, extraction_data, created_at)
         VALUES ('msg1', ?, 'user', 'test', 1, '{}', '{}', datetime('now'))`,
      ).run(ep.id);

      const ext = service.storeExtraction({
        message_id: "msg1",
        entity_type: "person",
        entity_id: "contact-123",
        label: "John Doe",
        confidence: 0.95,
      });

      expect(ext.id).toBeTruthy();
      expect(ext.entity_type).toBe("person");
      expect(ext.label).toBe("John Doe");
    });

    it("filters extractions by type", () => {
      const ep = service.createEpisode({});
      db.prepare(
        `INSERT INTO chat_messages (id, episode_id, role, content, token_count, context_used, extraction_data, created_at)
         VALUES ('msg2', ?, 'user', 'test', 1, '{}', '{}', datetime('now'))`,
      ).run(ep.id);

      service.storeExtraction({
        message_id: "msg2",
        entity_type: "person",
        label: "Alice",
        confidence: 0.9,
      });
      service.storeExtraction({
        message_id: "msg2",
        entity_type: "concept",
        label: "AI",
        confidence: 0.8,
      });

      const persons = service.getExtractions({ entity_type: "person" });
      expect(persons).toHaveLength(1);
      expect(persons[0].label).toBe("Alice");

      const concepts = service.getExtractions({ entity_type: "concept" });
      expect(concepts).toHaveLength(1);
      expect(concepts[0].label).toBe("AI");
    });
  });

  // ── Events ────────────────────────────────────────

  describe("events", () => {
    it("emits data.changed on episode creation", () => {
      let emitted = false;
      events.on("data.changed", () => {
        emitted = true;
      });
      service.createEpisode({});
      expect(emitted).toBe(true);
    });

    it("emits data.changed on archive", () => {
      const ep = service.createEpisode({});
      let emitted = false;
      events.on("data.changed", () => {
        emitted = true;
      });
      service.archiveEpisode(ep.id);
      expect(emitted).toBe(true);
    });
  });

  // ── Knowledge & Context ───────────────────────────

  describe("knowledge integration", () => {
    it("getKnowledgeService returns a KnowledgeService", () => {
      const ks = service.getKnowledgeService();
      expect(ks).toBeTruthy();
      // Neo4j unavailable in tests
      expect(ks.available).toBe(false);
    });

    it("getContextEngine returns a ContextEngine", () => {
      const ce = service.getContextEngine();
      expect(ce).toBeTruthy();
    });

    it("reinforceMemory returns false when Neo4j unavailable", async () => {
      const ok = await service.reinforceMemory("some-id");
      expect(ok).toBe(false);
    });

    it("previewContext falls back gracefully without Neo4j", async () => {
      const ep = service.createEpisode({});
      const ctx = await service.previewContext("test query", ep.id);
      // Without Neo4j or FTS data, should return empty context
      expect(ctx.method).toBe("fts_fallback");
      expect(ctx.memories).toHaveLength(0);
    });

    it("previewContext uses FTS when messages exist", async () => {
      const ep = service.createEpisode({});
      // Add some messages with FTS entries
      db.prepare(
        `INSERT INTO chat_messages (id, episode_id, role, content, token_count, context_used, extraction_data, created_at)
         VALUES ('ctx1', ?, 'user', 'machine learning models are powerful', 5, '{}', '{}', datetime('now'))`,
      ).run(ep.id);
      db.prepare(
        "INSERT INTO chat_messages_fts (message_id, content) VALUES ('ctx1', 'machine learning models are powerful')",
      ).run();

      const ctx = await service.previewContext("machine learning", ep.id);
      expect(ctx.method).toBe("fts_fallback");
      expect(ctx.totalTokens).toBeGreaterThan(0);
      expect(ctx.contextText).toContain("machine learning");
    });
  });
});

// ── ExtractionPipeline ──────────────────────────────

describe("ExtractionPipeline", () => {
  let db: InstanceType<typeof Database>;
  let pipeline: ExtractionPipeline;
  let events: EventBus;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "chat", chatMigrations);
    // Create contacts and tasks tables for entity resolution
    db.prepare(`CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
      relationship TEXT NOT NULL DEFAULT 'acquaintance', notes TEXT NOT NULL DEFAULT '',
      last_interaction TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
      context TEXT NOT NULL DEFAULT '', due_date TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`).run();
    events = new EventBus();
    const knowledge = new KnowledgeService(() => null);
    pipeline = new ExtractionPipeline(db, knowledge, events);
  });
  afterEach(() => db.close());

  function insertEpAndMsg(epId: string, msgId: string, content: string): void {
    db.prepare(
      `INSERT INTO chat_episodes (id, title, summary, status, message_count, llm_provider, llm_model, total_tokens, created_at, updated_at)
       VALUES (?, '', '', 'active', 1, '', '', 0, datetime('now'), datetime('now'))`,
    ).run(epId);
    db.prepare(
      `INSERT INTO chat_messages (id, episode_id, role, content, token_count, context_used, extraction_data, created_at)
       VALUES (?, ?, 'user', ?, 5, '{}', '{}', datetime('now'))`,
    ).run(msgId, epId, content);
  }

  it("uses heuristic extraction when no LLM available", async () => {
    insertEpAndMsg("ep1", "msg-ext1", "I talked to John Smith about the project");

    const extractions = await pipeline.extract(
      "msg-ext1", "ep1",
      "I talked to John Smith about the project",
      "That sounds great!",
      null,
    );

    expect(extractions.length).toBeGreaterThanOrEqual(1);
    expect(extractions[0].entity_type).toBe("person");
    expect(extractions[0].label).toBe("John Smith");
  });

  it("resolves contacts against CRM", async () => {
    db.prepare(
      `INSERT INTO contacts (id, name, email, created_at, updated_at)
       VALUES ('c1', 'John Smith', 'john@test.com', datetime('now'), datetime('now'))`,
    ).run();
    insertEpAndMsg("ep2", "msg-ext2", "I talked to John Smith yesterday");

    const extractions = await pipeline.extract(
      "msg-ext2", "ep2",
      "I talked to John Smith yesterday",
      "I will let him know.",
      null,
    );

    expect(extractions.length).toBeGreaterThanOrEqual(1);
    const personExt = extractions.find((e) => e.entity_type === "person");
    expect(personExt).toBeTruthy();
    expect(personExt!.entity_id).toBe("c1");
    expect(personExt!.confidence).toBe(0.8);
  });

  it("emits chat.extraction event", async () => {
    insertEpAndMsg("ep3", "msg-ext3", "I need to meet with Alice Johnson tomorrow");

    let emitted = false;
    events.on("chat.extraction", () => { emitted = true; });

    await pipeline.extract(
      "msg-ext3", "ep3",
      "I need to meet with Alice Johnson tomorrow",
      "I'll schedule that.",
      null,
    );

    expect(emitted).toBe(true);
  });

  it("handles content with no extractable entities", async () => {
    insertEpAndMsg("ep4", "msg-ext4", "hello there");

    const extractions = await pipeline.extract(
      "msg-ext4", "ep4", "hello there", "Hi!", null,
    );

    expect(extractions).toHaveLength(0);
  });

  it("stores extractions in SQLite", async () => {
    insertEpAndMsg("ep5", "msg-ext5", "Call Maria Garcia please");

    await pipeline.extract(
      "msg-ext5", "ep5",
      "Call Maria Garcia please",
      "Sure thing.",
      null,
    );

    const stored = db
      .prepare("SELECT * FROM chat_extractions WHERE message_id = 'msg-ext5'")
      .all();
    expect(stored.length).toBeGreaterThanOrEqual(1);
  });
});

// ── KnowledgeService (unit tests without Neo4j) ─────

describe("KnowledgeService", () => {
  it("reports unavailable when Neo4j not connected", () => {
    const ks = new KnowledgeService(() => null);
    expect(ks.available).toBe(false);
  });

  it("getConcepts returns empty without Neo4j", async () => {
    const ks = new KnowledgeService(() => null);
    const concepts = await ks.getConcepts();
    expect(concepts).toHaveLength(0);
  });

  it("upsertConcept returns empty string without Neo4j", async () => {
    const ks = new KnowledgeService(() => null);
    const id = await ks.upsertConcept({ label: "test" });
    expect(id).toBe("");
  });

  it("findSimilarMemories returns empty without Neo4j", async () => {
    const ks = new KnowledgeService(() => null);
    const memories = await ks.findSimilarMemories(new Array(384).fill(0));
    expect(memories).toHaveLength(0);
  });

  it("traverseFromMemories returns empty result without Neo4j", async () => {
    const ks = new KnowledgeService(() => null);
    const result = await ks.traverseFromMemories(["some-id"]);
    expect(result.persons).toHaveLength(0);
    expect(result.tasks).toHaveLength(0);
  });

  it("getTemporalPatterns returns empty without Neo4j", async () => {
    const ks = new KnowledgeService(() => null);
    const patterns = await ks.getTemporalPatterns(10, 1);
    expect(patterns).toHaveLength(0);
  });

  it("runConceptAnalytics returns zero without Neo4j", async () => {
    const ks = new KnowledgeService(() => null);
    const analytics = await ks.runConceptAnalytics();
    expect(analytics.communities).toBe(0);
    expect(analytics.topConcepts).toHaveLength(0);
  });
});

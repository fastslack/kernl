import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/event-bus.js";
import type { KernelConfig } from "../src/core/config.js";
import type { ToolDefinition } from "../src/core/types.js";
import type { EmbeddingsClient } from "../src/core/embeddings/index.js";

import { createConfigModule } from "../src/modules/config/index.js";
import { createDashboardModule } from "../src/modules/dashboard/index.js";
import { createChatModule } from "../src/modules/chat/index.js";
import { createAgentsModule } from "../src/modules/agents/index.js";
import { createOfficeInfraModule } from "../src/modules/office-infra/index.js";
import { createMarketplaceModule } from "../src/modules/marketplace/index.js";
import { createBrainModule } from "../src/modules/brain/index.js";
import { createToolMemoryModule } from "../src/modules/tool-memory/index.js";
import { createMetaModule } from "../src/modules/meta/index.js";
import { createMcpPlansModule } from "../src/modules/mcp-plans/index.js";
import { createStoreModule } from "../src/modules/store/index.js";
import { createExtensionsModule } from "../src/modules/extensions/index.js";

/**
 * Tool-catalog smoke test.
 *
 * Boots each in-tree module against an in-memory context and asserts
 * invariants over the *combined* set of registered tools — most importantly
 * that no two modules register the same `kernel_*` name. This is the safety
 * net for the mass `defineTool` migration: a bad rename, a duplicate, or a
 * malformed schema surfaces here instead of at runtime.
 *
 * It asserts invariants, not an exact tool count, so adding a new tool never
 * breaks it. Modules that can't be constructed in a bare unit context are
 * recorded as skipped (logged) rather than faked — the uniqueness guarantee
 * still holds across everything that did load.
 */

// Deterministic stub embeddings — enough for modules that expect a client.
const mockEmbeddings: EmbeddingsClient = {
  provider: "local",
  model: "mock",
  dim: 1,
  async available() { return true; },
  async embed(texts) { return texts.map(() => [0]); },
};

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
      lat: 52.3676, lon: 4.9041, city: "Amsterdam", timezone: "Europe/Amsterdam",
      currencies: "USD", clocks: [], waterGoal: 8,
    },
    resend: { apiKey: "" },
    mcp: { transport: "stdio" },
    agents: {
      pollIntervalMs: 30000, maxConcurrentRuns: 3, minScheduleSeconds: 300, internalApiPort: 3087,
      defaultProvider: "", defaultModel: "", defaultModelChain: [], evalProvider: "", evalModel: "",
      learningCleanupIntervalMs: 3600000, learningMinConfidence: 0.15, maxInvokeDepth: 5,
      invokeTimeoutMs: 300000, inboxWakeQuietMs: 300000, subscriptionCooldownMs: 60000,
      useSemanticRanking: false, semanticRankingCosineWeight: 0.7, semanticRankingMinScore: 0.30,
    },
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
      pollIntervalMs: 60000, defaultLlm: "claude", anthropicApiKey: "", openaiApiKey: "",
      grokApiKey: "", grokDefaultModel: "", nvidiaApiKey: "", nvidiaDefaultModel: "",
      lmstudioBaseUrl: "", braveApiKey: "", googleCseKey: "", googleCseCx: "", searxngBaseUrl: "",
    },
    chat: {
      defaultProvider: "stub", defaultModel: "stub-model", extractionModel: "", contextBudget: 2000,
      maxEpisodeMessages: 100, decayIntervalMs: 3600000, patternDetectionIntervalMs: 86400000,
      systemPrompt: "You are a test assistant.",
    },
    store: { autoUpdate: true },
  };
}

const NAME_RE = /^kernel_[a-z0-9]+(_[a-z0-9]+)*$/;

/** A module factory paired with a label; each is booted independently. */
interface Candidate {
  name: string;
  make: () => { initialize(ctx: unknown): Promise<void>; getTools(): ToolDefinition[] };
}

const collected: ToolDefinition[] = [];
const skipped: Array<{ module: string; reason: string }> = [];
const perModuleCounts: Record<string, number> = {};
let db: Database;

describe("tool catalog", () => {
  afterAll(() => {
    db?.close();
  });

  beforeAll(async () => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    const ctx = {
      sqlite: db,
      neo4j: { available: false, run: async () => ({ records: [] }), close: async () => {} },
      graph: null,
      events: new EventBus(),
      config: stubConfig(),
      systemRegistry: { register: () => "", unregister: () => {}, list: () => [] },
      notifier: { send: async () => {}, broadcast: async () => {}, getRegistry: () => null },
      license: { has: () => false },
      getModule: () => null,
    } as unknown;

    const metaGetters = {
      getCatalog: () => collected,
      getIdentity: () => undefined,
      getCostRouter: () => undefined,
      getEmbeddings: () => mockEmbeddings,
      getCompleter: () => undefined,
      getDispatcher: () => async () => ({ isError: false, output: {}, duration_ms: 0 }),
    };

    const candidates: Candidate[] = [
      { name: "config", make: () => createConfigModule() },
      { name: "dashboard", make: () => createDashboardModule() },
      { name: "chat", make: () => createChatModule() },
      { name: "agents", make: () => createAgentsModule() },
      { name: "office-infra", make: () => createOfficeInfraModule() },
      { name: "marketplace", make: () => createMarketplaceModule(null, null) },
      { name: "brain", make: () => createBrainModule(() => Promise.resolve(mockEmbeddings)) },
      { name: "tool-memory", make: () => createToolMemoryModule(() => Promise.resolve(mockEmbeddings)) },
      { name: "meta", make: () => createMetaModule(metaGetters as never) },
      { name: "mcp-plans", make: () => createMcpPlansModule(metaGetters as never) },
      { name: "store", make: () => createStoreModule({ getExtensionService: () => null, getAgentService: () => null }) },
      { name: "extensions", make: () => createExtensionsModule({ dataPath: mkdtempSync(join(tmpdir(), "kernl-catalog-")) }) },
    ];

    for (const c of candidates) {
      try {
        const mod = c.make();
        // Guard against a module whose initialize() blocks (e.g. awaiting a
        // dependency that never arrives in this bare context).
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            mod.initialize(ctx as never),
            new Promise((_, rej) => {
              timer = setTimeout(() => rej(new Error("initialize() timed out")), 8000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        const tools = mod.getTools();
        perModuleCounts[c.name] = tools.length;
        collected.push(...tools);
      } catch (err) {
        skipped.push({ module: c.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    if (skipped.length > 0) {
      // Visible in test output — a skip is coverage lost, not a silent pass.
      console.warn("[tool-catalog] modules skipped:", JSON.stringify(skipped));
    }
    console.warn("[tool-catalog] per-module tool counts:", JSON.stringify(perModuleCounts));
  });

  it("constructs every candidate module (no skips)", () => {
    // All 12 candidates are expected to build in a bare in-memory context.
    // A skip means a module's initialize() regressed (threw or hung) — surface
    // it as a failure with the recorded reasons, not just a console warning.
    expect(skipped).toEqual([]);
  });

  it("registers a non-trivial number of tools (floor, not exact)", () => {
    expect(collected.length).toBeGreaterThanOrEqual(40);
  });

  it("every tool name matches kernel_<snake> convention", () => {
    const bad = collected.filter((t) => !NAME_RE.test(t.name)).map((t) => t.name);
    expect(bad).toEqual([]);
  });

  it("tool names are globally unique across modules", () => {
    const seen = new Map<string, number>();
    for (const t of collected) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([name, n]) => `${name} (x${n})`);
    expect(dupes).toEqual([]);
  });

  it("every tool has a non-empty description", () => {
    const missing = collected.filter((t) => !t.description || t.description.trim() === "").map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("every tool has an input schema and a handler function", () => {
    const broken = collected
      .filter((t) => !t.inputSchema || typeof t.handler !== "function")
      .map((t) => t.name);
    expect(broken).toEqual([]);
  });
});

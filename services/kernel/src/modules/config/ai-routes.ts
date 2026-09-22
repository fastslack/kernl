/**
 * AI Providers Configuration Routes
 *
 * GET  /api/config/ai  — Returns current provider status (keys masked, models, defaults)
 * POST /api/config/ai  — Saves new key/model settings to .env + updates process.env in-memory
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { HttpError, type KernelHttpServer } from "../../core/http-server.js";
import type { KernelConfig } from "../../core/config.js";
import type { EventBus } from "../../core/event-bus.js";
import { log } from "../../core/logger.js";
import type { ChatService } from "../chat/service.js";
import type { AgentExecutor } from "../agents/executor.js";
import type { ConfigService } from "./service.js";
import { createChatProviders } from "../../core/llm/chat-adapters.js";
import { reloadLlmClient } from "../../core/llm/client.js";
import { legacyCredentialTarget, legacyToStoredPatch } from "../../core/llm/credentials-legacy.js";
import { getProviderConfig, isConnected, saveProviderConfig } from "../../core/llm/credentials.js";

/** Mask a key: show first 8 chars + *** */
function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return key.slice(0, 2) + "***";
  return key.slice(0, 8) + "***" + key.slice(-4);
}

/** Read the .env file as a map of key→value */
function readEnvFile(envPath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(envPath)) return map;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    map.set(k, v);
  }
  return map;
}

/** Write map back to .env, preserving comments and order */
export function writeEnvFile(envPath: string, updates: Record<string, string>): void {
  let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const lines = content.split("\n");
  const written = new Set<string>();

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return line;
    const k = trimmed.slice(0, eq).trim();
    if (k in updates) {
      written.add(k);
      const v = updates[k];
      return `${k}=${v}`;
    }
    return line;
  });

  // Append any keys not yet in the file
  for (const [k, v] of Object.entries(updates)) {
    if (!written.has(k)) {
      newLines.push(`${k}=${v}`);
    }
  }

  writeFileSync(envPath, newLines.join("\n"), "utf-8");
}

export function registerAiConfigRoutes(
  server: KernelHttpServer,
  config: KernelConfig,
  chatService?: ChatService,
  agentExecutor?: AgentExecutor,
  events?: EventBus,
  db?: import("../../core/db/sqlite.js").SqliteDb,
  llmRegistry?: import("../../core/llm/provider-registry.js").LlmProviderRegistry,
  configService?: ConfigService,
): void {
  const envPath = resolve(process.cwd(), ".env");

  // ── GET /api/config/ai ──────────────────────────────────
  server.route("GET", "/api/config/ai", () => {
    const anthropicKey = getProviderConfig("claude").apiKey;
    const openaiKey = getProviderConfig("openai").apiKey;
    const grokKey = getProviderConfig("grok").apiKey;
    const nvidiaKey = getProviderConfig("nvidia").apiKey;
    const lmstudioBaseUrl = isConnected("lmstudio") ? getProviderConfig("lmstudio").baseUrl : "";
    const elevenLabsKey = config.voice.elevenLabsApiKey;

    return {
      providers: {
        anthropic: {
          configured: anthropicKey.length > 0,
          keyMasked: maskKey(anthropicKey),
          // never send the raw key to the browser
        },
        openai: {
          configured: openaiKey.length > 0,
          keyMasked: maskKey(openaiKey),
        },
        grok: {
          configured: grokKey.length > 0,
          keyMasked: maskKey(grokKey),
          defaultModel: getProviderConfig("grok").model,
        },
        nvidia: {
          configured: nvidiaKey.length > 0,
          keyMasked: maskKey(nvidiaKey),
          defaultModel: getProviderConfig("nvidia").model,
        },
        lmstudio: {
          configured: lmstudioBaseUrl.length > 0,
          baseUrl: lmstudioBaseUrl,
        },
        minimax: (() => {
          // MiniMax is registry-native (no config.webIntel home). Read its
          // settings_json (falling back to env) for the masked state.
          const mm = (llmRegistry?.loadConfig("minimax") ?? {}) as Record<string, unknown>;
          const key = typeof mm.apiKey === "string" ? mm.apiKey : "";
          const model = typeof mm.defaultModel === "string" ? mm.defaultModel : "";
          return { configured: key.length > 0, keyMasked: maskKey(key), defaultModel: model };
        })(),
        elevenlabs: {
          configured: elevenLabsKey.length > 0,
          keyMasked: maskKey(elevenLabsKey),
        },
      },
      defaults: {
        chatProvider: config.chat.defaultProvider,
        chatModel: config.chat.defaultModel,
        agentsProvider: config.agents.defaultProvider,
        agentsModel: config.agents.defaultModel,
        agentsDefaultModelChain: config.agents.defaultModelChain ?? [],
        webIntelLlm: config.webIntel.defaultLlm,
      },
      envFileExists: existsSync(envPath),
    };
  });

  // ── POST /api/config/ai ─────────────────────────────────
  server.route<{
    anthropicApiKey?: string;
    openaiApiKey?: string;
    grokApiKey?: string;
    grokDefaultModel?: string;
    nvidiaApiKey?: string;
    nvidiaDefaultModel?: string;
    minimaxApiKey?: string;
    minimaxBaseUrl?: string;
    minimaxDefaultModel?: string;
    lmstudioBaseUrl?: string;
    elevenLabsApiKey?: string;
    googleClientId?: string;
    googleClientSecret?: string;
    chatProvider?: string;
    chatModel?: string;
    agentsProvider?: string;
    agentsModel?: string;
    agentsDefaultModelChain?: Array<{ provider: string; model: string }>;
    webIntelLlm?: string;
  }>("POST", "/api/config/ai", async ({ body }) => {
    // Per-request tracking of persisted keys. `persist()` routes through
    // ConfigService (settings store: app_settings + .env + process.env mirror
    // + config:changed) when available, and ALWAYS mirrors process.env so the
    // in-process provider re-init below sees the new value regardless. When
    // ConfigService isn't wired (defensive), the fallback block at the bottom
    // does the legacy batch .env write + manual event emit.
    const envUpdates: Record<string, string> = {};
    const persist = (key: string, value: string): void => {
      envUpdates[key] = value;
      // Credentials are saved by the config assignment that follows each
      // persist() call (a registry accessor); they never touch env or .env.
      if (legacyCredentialTarget(key)) return;
      process.env[key] = value; // env mirror — provider re-init reads process.env
      if (configService) {
        try { configService.set(key, value, "user"); } catch { /* keep going; env mirror already applied */ }
      }
    };
    // Credential keys route through the provider registry instead of
    // config.webIntel/config.voice (those fields no longer exist).
    const persistCredential = (envKey: string, value: string): void => {
      persist(envKey, value);
      const legacy = legacyToStoredPatch(envKey, value);
      if (legacy) saveProviderConfig(legacy.slug, legacy.patch);
    };

    // API Keys — only update if a non-empty value was provided
    // (empty string means "leave unchanged")
    if (body.anthropicApiKey !== undefined && body.anthropicApiKey !== "") {
      persistCredential("ANTHROPIC_API_KEY", body.anthropicApiKey);
    }
    if (body.openaiApiKey !== undefined && body.openaiApiKey !== "") {
      persistCredential("OPENAI_API_KEY", body.openaiApiKey);
    }
    if (body.grokApiKey !== undefined && body.grokApiKey !== "") {
      persistCredential("GROK_API_KEY", body.grokApiKey);
    }
    if (body.grokDefaultModel !== undefined) {
      persistCredential("GROK_DEFAULT_MODEL", body.grokDefaultModel);
    }
    if (body.nvidiaApiKey !== undefined && body.nvidiaApiKey !== "") {
      persistCredential("NVIDIA_API_KEY", body.nvidiaApiKey);
    }
    if (body.nvidiaDefaultModel !== undefined) {
      persistCredential("NVIDIA_DEFAULT_MODEL", body.nvidiaDefaultModel);
    }
    if (body.googleClientId !== undefined && body.googleClientId !== "") {
      persist("GOOGLE_CLIENT_ID", body.googleClientId);
      config.google.clientId = body.googleClientId;
    }
    if (body.googleClientSecret !== undefined && body.googleClientSecret !== "") {
      persist("GOOGLE_CLIENT_SECRET", body.googleClientSecret);
      config.google.clientSecret = body.googleClientSecret;
    }
    if (body.lmstudioBaseUrl !== undefined) {
      persistCredential("LMSTUDIO_BASE_URL", body.lmstudioBaseUrl);
    }
    if (body.elevenLabsApiKey !== undefined && body.elevenLabsApiKey !== "") {
      persist("ELEVENLABS_API_KEY", body.elevenLabsApiKey);
      config.voice.elevenLabsApiKey = body.elevenLabsApiKey;
    }

    // MiniMax — registry-native provider: the registry settings_json is the
    // source of truth. Persist there + mirror to the settings store/env.
    {
      const mm = (llmRegistry?.loadConfig("minimax") ?? {}) as Record<string, unknown>;
      let mmChanged = false;
      if (body.minimaxApiKey !== undefined && body.minimaxApiKey !== "") {
        mm.apiKey = body.minimaxApiKey; mmChanged = true;
        persist("MINIMAX_API_KEY", body.minimaxApiKey);
      }
      if (body.minimaxBaseUrl !== undefined) {
        mm.baseUrl = body.minimaxBaseUrl; mmChanged = true;
        persist("MINIMAX_BASE_URL", body.minimaxBaseUrl);
      }
      if (body.minimaxDefaultModel !== undefined) {
        mm.defaultModel = body.minimaxDefaultModel; mmChanged = true;
        persist("MINIMAX_DEFAULT_MODEL", body.minimaxDefaultModel);
      }
      if (mmChanged && llmRegistry) {
        llmRegistry.saveConfig("minimax", mm);
        await llmRegistry.startProvider("minimax").catch(() => {});
      }
    }

    // Defaults
    if (body.chatProvider !== undefined) {
      persist("CHAT_DEFAULT_PROVIDER", body.chatProvider);
      config.chat.defaultProvider = body.chatProvider;
    }
    if (body.chatModel !== undefined) {
      persist("CHAT_DEFAULT_MODEL", body.chatModel);
      config.chat.defaultModel = body.chatModel;
    }
    if (body.agentsProvider !== undefined) {
      persist("AGENTS_DEFAULT_PROVIDER", body.agentsProvider);
      config.agents.defaultProvider = body.agentsProvider;
    }
    if (body.agentsModel !== undefined) {
      persist("AGENTS_DEFAULT_MODEL", body.agentsModel);
      config.agents.defaultModel = body.agentsModel;
    }
    if (body.agentsDefaultModelChain !== undefined) {
      const cleaned = Array.isArray(body.agentsDefaultModelChain)
        ? body.agentsDefaultModelChain
            .filter((e) => e && typeof e === "object")
            .map((e) => ({ provider: String(e.provider ?? ""), model: String(e.model ?? "") }))
            .filter((e) => e.provider || e.model)
        : [];
      const serialized = JSON.stringify(cleaned);
      persist("AGENTS_DEFAULT_MODEL_CHAIN", serialized);
      config.agents.defaultModelChain = cleaned;
    }
    if (body.webIntelLlm !== undefined) {
      persist("WEBINTEL_DEFAULT_LLM", body.webIntelLlm);
      config.webIntel.defaultLlm = body.webIntelLlm;
    }

    if (Object.keys(envUpdates).length > 0) {
      if (configService) {
        // ConfigService already persisted each key (app_settings + .env +
        // process.env) and emitted config:changed. Nothing more to write.
        log.info(`AI config updated: ${Object.keys(envUpdates).join(", ")}`);
      } else {
        // Fallback (ConfigService not wired): legacy batch .env write + emit.
        // Credentials never reach .env or a config:changed payload — they were
        // already saved to the registry by the config assignment above.
        const persistable = Object.fromEntries(
          Object.entries(envUpdates).filter(([k]) => !legacyCredentialTarget(k)),
        );
        if (Object.keys(persistable).length > 0) {
          try {
            writeEnvFile(envPath, persistable);
            log.info(`AI config updated: ${Object.keys(envUpdates).join(", ")}`);
          } catch (writeErr) {
            // Non-fatal: in-memory update still applied, just can't persist
            log.warn("Could not write .env file — in-memory only", writeErr);
          }
          if (events) {
            for (const [key, value] of Object.entries(persistable)) {
              events.emit("config:changed", { key, value, updatedBy: "http" });
            }
          }
        }
      }

      // Hot-reload LLM providers so Chat, Agents AND the llm() singleton
      // (EmailTriage, comms, analysis — anything using the standalone client)
      // pick up key changes + chain changes without a restart.
      const providerKeysChanged = [
        "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LMSTUDIO_BASE_URL",
        "GROK_API_KEY", "XAI_API_KEY", "GROK_DEFAULT_MODEL",
        "NVIDIA_API_KEY", "NVIDIA_DEFAULT_MODEL",
        "MINIMAX_API_KEY", "MINIMAX_BASE_URL", "MINIMAX_DEFAULT_MODEL",
        "CHAT_DEFAULT_PROVIDER", "CHAT_DEFAULT_MODEL",
        "AGENTS_DEFAULT_PROVIDER", "AGENTS_DEFAULT_MODEL",
        "AGENTS_DEFAULT_MODEL_CHAIN",
      ].some((k) => k in envUpdates);
      if (providerKeysChanged) {
        if (chatService) chatService.reloadProviders();
        if (agentExecutor) {
          const newProviders = createChatProviders({ claudeCode: config.claudeCode });
          agentExecutor.setProviders(newProviders, config.agents.defaultProvider || config.chat.defaultProvider);
        }
        // Rebuild the standalone llm() singleton's config so EmailTriage,
        // email-analysis, and any other code path using `llm()` picks up
        // the new chain immediately.
        reloadLlmClient(config);
        log.info("LLM providers hot-reloaded (including llm() singleton)");
      }
    }

    return {
      success: true,
      updated: Object.keys(envUpdates),
      envPersisted: existsSync(envPath),
      note: Object.keys(envUpdates).length === 0
        ? "No changes detected"
        : "Providers reloaded — no restart needed.",
    };
  });

  // ── GET /api/config/ai/test/:provider — Test provider connectivity ──
  server.route("GET", "/api/config/ai/test", async () => {
    // Delegate to the central helper that probes each provider via the
    // registry's `listModels()` — same logic for both this HTTP endpoint
    // and the `config.ai.test` RPC, no more 100-line duplicated fetch blocks.
    if (!llmRegistry) throw new HttpError(503, "llmRegistry not wired into ai-routes");
    const { testAllProviders } = await import("../../core/llm/test-providers.js");
    return testAllProviders(llmRegistry);
  });

  // ── GET /api/config/ai/lm-models — Proxy to LMStudio /v1/models (avoids CORS) ──
  server.route("GET", "/api/config/ai/lm-models", async () => {
    try {
      const baseUrl = (getProviderConfig("lmstudio").baseUrl || "http://localhost:1234/v1").replace(/\/+$/, "");
      const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
      const body = await r.json() as any;
      const models = (body.data ?? []).map((m: any) => m.id);
      return { models };
    } catch (err) {
      // LMStudio being down is an answer, not a failure: empty list + why.
      return { models: [], error: String(err) };
    }
  });

  // ── GET /api/config/ai/providers — registry-driven provider list ─────────
  // Single source of truth for the canonical /providers settings page. Returns
  // every provider with its config schema + MASKED current values (raw secrets
  // never leave the server). The page renders forms dynamically from this, so
  // new providers (e.g. minimax) appear with zero frontend hardcoding.
  server.route("GET", "/api/config/ai/providers", () => {
    if (!llmRegistry) throw new HttpError(503, "llmRegistry unavailable");
    const out = llmRegistry.getStatuses().map((st) => {
      const cfg = llmRegistry.loadConfig(st.slug) as Record<string, unknown>;
      const schema = llmRegistry.getConfigSchema(st.slug) ?? [];
      const values: Record<string, string> = {};
      for (const f of schema) {
        const raw = typeof cfg[f.key] === "string" ? (cfg[f.key] as string) : "";
        values[f.key] = f.type === "password" ? maskKey(raw) : raw;
      }
      return {
        slug: st.slug,
        name: st.name,
        source: st.source,
        ready: st.ready,
        error: st.error,
        schema,
        values,
      };
    });
    return { providers: out };
  });

  // ── GET /api/config/ai/agents — List agents with their LLM assignments ──
  server.route("GET", "/api/config/ai/agents", () => {
    try {
      if (!db) return { agents: [] };
      const agents = db.prepare(
        "SELECT id, name, description, provider, model, active, builtin_handler FROM agents WHERE active = 1 ORDER BY name"
      ).all();
      return { agents };
    } catch {
      return { agents: [] };
    }
  });

  // ── POST /api/config/ai/agents/update — Update agent's LLM provider/model ──
  server.route<{ agent_id: string; provider: string; model: string }>(
    "POST", "/api/config/ai/agents/update", ({ body }) => {
      if (!db) throw new HttpError(500, "DB not available");
      db.prepare("UPDATE agents SET provider = ?, model = ?, updated_at = datetime('now') WHERE id = ?")
        .run(body.provider, body.model, body.agent_id);
      return { success: true };
    },
  );

  // ── GET /api/config/public — unauthenticated config (language, etc.) ──────
  server.route("GET", "/api/config/public", () => ({
    language: config.language,
  }));

  // ── POST /api/config/language — change the system language ────────────────
  server.route<{ language?: string }>("POST", "/api/config/language", ({ body }) => {
    const raw = (body.language ?? "").trim();
    if (raw !== "es" && raw !== "en") {
      throw new HttpError(400, "language must be 'es' or 'en'");
    }
    process.env["KERNEL_DEFAULT_LANGUAGE"] = raw; // env mirror
    config.language = raw;

    if (configService) {
      // Settings store: persists app_settings + .env + emits config:changed.
      try { configService.set("KERNEL_DEFAULT_LANGUAGE", raw, "user"); } catch { /* env mirror already applied */ }
    } else {
      // Fallback: persist to .env so it survives restarts.
      try {
        writeEnvFile(envPath, { KERNEL_DEFAULT_LANGUAGE: raw });
      } catch (err) {
        log.warn("Could not write .env for KERNEL_DEFAULT_LANGUAGE", err);
      }
      // Notify ConfigService so it syncs app_settings.
      if (events) {
        events.emit("config:changed", {
          key: "KERNEL_DEFAULT_LANGUAGE",
          value: raw,
          updatedBy: "http",
        });
      }
    }

    return { success: true, language: raw };
  });

  log.info("AI config routes registered (/api/config/ai)");
}

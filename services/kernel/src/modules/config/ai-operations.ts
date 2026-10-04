/**
 * AI config operations the dashboard reaches over both the WS RPC and HTTP
 * (`config.ai.*` ↔ `/api/config/ai*`).
 *
 * The dashboard calls each of these through `rpcOrCall`, so the RPC action
 * and the HTTP route are the same request by two roads and have to answer
 * alike. They used to be written twice and had drifted: `config.ai.get` over
 * RPC left out `agentsDefaultModelChain`, `config.ai.save` over RPC dropped
 * the chain and did not hot-reload the providers when only a default
 * provider/model changed, and the agents SQL and `maskKey` were copy-pasted.
 * Now dashboard/rpc-actions.ts exposes this map as is and ai-routes.ts binds
 * each entry to its path; where the two disagreed, the fuller behaviour won.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Operation } from "../../sdk/args.js";
import { pickArgs } from "../../sdk/args.js";
import { HttpError } from "../../sdk/http-error.js";
import type { KernelConfig } from "../../core/config.js";
import type { EventBus } from "../../core/event-bus.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { LlmProviderRegistry } from "../../core/llm/provider-registry.js";
import { log } from "../../core/logger.js";
import type { ChatService } from "../chat/service.js";
import type { AgentExecutor } from "../agents/executor.js";
import type { ConfigService } from "./service.js";
import { createChatProviders } from "../../core/llm/chat-adapters.js";
import { reloadLlmClient } from "../../core/llm/client.js";
import { legacyCredentialTarget, legacyToStoredPatch } from "../../core/llm/credentials-legacy.js";
import { getProviderConfig, isConnected, saveProviderConfig } from "../../core/llm/credentials.js";

/** Mask a key: show first 8 chars + *** */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return key.slice(0, 2) + "***";
  return key.slice(0, 8) + "***" + key.slice(-4);
}

/** Write map back to .env, preserving comments and order */
export function writeEnvFile(envPath: string, updates: Record<string, string>): void {
  const content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
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

/** Settings whose change rebuilds the chat/agent providers and the llm() singleton. */
const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LMSTUDIO_BASE_URL",
  "GROK_API_KEY", "XAI_API_KEY", "GROK_DEFAULT_MODEL",
  "NVIDIA_API_KEY", "NVIDIA_DEFAULT_MODEL",
  "MINIMAX_API_KEY", "MINIMAX_BASE_URL", "MINIMAX_DEFAULT_MODEL",
  "CHAT_DEFAULT_PROVIDER", "CHAT_DEFAULT_MODEL",
  "AGENTS_DEFAULT_PROVIDER", "AGENTS_DEFAULT_MODEL",
  "AGENTS_DEFAULT_MODEL_CHAIN",
];

export interface AiConfigOperationDeps {
  config: KernelConfig;
  chatService?: ChatService | null;
  agentExecutor?: AgentExecutor | null;
  events?: EventBus | null;
  db?: SqliteDb | null;
  /** LLM provider registry — `config.ai.test` delegates to each provider's
   *  `listModels()` through it; MiniMax settings live in it. */
  llmRegistry?: LlmProviderRegistry | null;
  /** Settings store (app_settings + .env + process.env mirror + config:changed).
   *  Optional — when absent, `config.ai.save` falls back to the legacy
   *  .env-only write. */
  configService?: ConfigService | null;
}

export function aiConfigOperations(deps: AiConfigOperationDeps): Record<string, Operation> {
  const { config, chatService, agentExecutor, events, db, llmRegistry, configService } = deps;
  const envPath = resolve(process.cwd(), ".env");

  return {
    "config.ai.get": () => {
      const anthropicKey = getProviderConfig("claude").apiKey;
      const openaiKey = getProviderConfig("openai").apiKey;
      const grokKey = getProviderConfig("grok").apiKey;
      const nvidiaKey = getProviderConfig("nvidia").apiKey;
      const lmstudioBaseUrl = isConnected("lmstudio") ? getProviderConfig("lmstudio").baseUrl : "";
      const elevenLabsKey = config.voice.elevenLabsApiKey;

      // Keys are masked: never send the raw key to the browser.
      return {
        providers: {
          anthropic: { configured: anthropicKey.length > 0, keyMasked: maskKey(anthropicKey) },
          openai: { configured: openaiKey.length > 0, keyMasked: maskKey(openaiKey) },
          grok: { configured: grokKey.length > 0, keyMasked: maskKey(grokKey), defaultModel: getProviderConfig("grok").model },
          nvidia: { configured: nvidiaKey.length > 0, keyMasked: maskKey(nvidiaKey), defaultModel: getProviderConfig("nvidia").model },
          lmstudio: { configured: lmstudioBaseUrl.length > 0, baseUrl: lmstudioBaseUrl },
          minimax: (() => {
            // MiniMax is registry-native (no config.webIntel home). Read its
            // settings_json (falling back to env) for the masked state.
            const mm = (llmRegistry?.loadConfig("minimax") ?? {}) as Record<string, unknown>;
            const key = typeof mm.apiKey === "string" ? mm.apiKey : "";
            const model = typeof mm.defaultModel === "string" ? mm.defaultModel : "";
            return { configured: key.length > 0, keyMasked: maskKey(key), defaultModel: model };
          })(),
          elevenlabs: { configured: elevenLabsKey.length > 0, keyMasked: maskKey(elevenLabsKey) },
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
    },

    "config.ai.save": async (input) => {
      // A key/secret field is only written when non-empty (empty means "leave
      // unchanged"). Any other field is written whenever it is present; null
      // counts as "" (clear it), which is how the RPC always read it.
      const secret = (k: string): string | undefined =>
        typeof input[k] === "string" && input[k] !== "" ? (input[k] as string) : undefined;
      const field = (k: string): string | undefined =>
        typeof input[k] === "string" ? (input[k] as string) : input[k] === null ? "" : undefined;

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
      const persistCredential = (envKey: string, value: string | undefined): void => {
        if (value === undefined) return;
        persist(envKey, value);
        const legacy = legacyToStoredPatch(envKey, value);
        if (legacy) saveProviderConfig(legacy.slug, legacy.patch);
      };

      // API Keys
      persistCredential("ANTHROPIC_API_KEY", secret("anthropicApiKey"));
      persistCredential("OPENAI_API_KEY", secret("openaiApiKey"));
      persistCredential("GROK_API_KEY", secret("grokApiKey"));
      persistCredential("GROK_DEFAULT_MODEL", field("grokDefaultModel"));
      persistCredential("NVIDIA_API_KEY", secret("nvidiaApiKey"));
      persistCredential("NVIDIA_DEFAULT_MODEL", field("nvidiaDefaultModel"));
      const googleClientId = secret("googleClientId");
      if (googleClientId !== undefined) {
        persist("GOOGLE_CLIENT_ID", googleClientId);
        config.google.clientId = googleClientId;
      }
      const googleClientSecret = secret("googleClientSecret");
      if (googleClientSecret !== undefined) {
        persist("GOOGLE_CLIENT_SECRET", googleClientSecret);
        config.google.clientSecret = googleClientSecret;
      }
      persistCredential("LMSTUDIO_BASE_URL", field("lmstudioBaseUrl"));
      const elevenLabsApiKey = secret("elevenLabsApiKey");
      if (elevenLabsApiKey !== undefined) {
        persist("ELEVENLABS_API_KEY", elevenLabsApiKey);
        config.voice.elevenLabsApiKey = elevenLabsApiKey;
      }

      // MiniMax — registry-native provider: the registry settings_json is the
      // source of truth. Persist there + mirror to the settings store/env.
      {
        const mm = (llmRegistry?.loadConfig("minimax") ?? {}) as Record<string, unknown>;
        let mmChanged = false;
        const minimax: Array<[string, string, string | undefined]> = [
          ["apiKey", "MINIMAX_API_KEY", secret("minimaxApiKey")],
          ["baseUrl", "MINIMAX_BASE_URL", field("minimaxBaseUrl")],
          ["defaultModel", "MINIMAX_DEFAULT_MODEL", field("minimaxDefaultModel")],
        ];
        for (const [prop, envKey, value] of minimax) {
          if (value === undefined) continue;
          mm[prop] = value; mmChanged = true;
          persist(envKey, value);
        }
        if (mmChanged && llmRegistry) {
          llmRegistry.saveConfig("minimax", mm);
          await llmRegistry.startProvider("minimax").catch(() => {});
        }
      }

      // Defaults
      const defaults: Array<[string, string, (v: string) => void]> = [
        ["chatProvider", "CHAT_DEFAULT_PROVIDER", (v) => { config.chat.defaultProvider = v; }],
        ["chatModel", "CHAT_DEFAULT_MODEL", (v) => { config.chat.defaultModel = v; }],
        ["agentsProvider", "AGENTS_DEFAULT_PROVIDER", (v) => { config.agents.defaultProvider = v; }],
        ["agentsModel", "AGENTS_DEFAULT_MODEL", (v) => { config.agents.defaultModel = v; }],
      ];
      for (const [k, envKey, apply] of defaults) {
        const value = field(k);
        if (value === undefined) continue;
        persist(envKey, value);
        apply(value);
      }
      if (input.agentsDefaultModelChain !== undefined) {
        const chain = input.agentsDefaultModelChain;
        const cleaned = Array.isArray(chain)
          ? chain
              .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
              .map((e) => ({ provider: String(e.provider ?? ""), model: String(e.model ?? "") }))
              .filter((e) => e.provider || e.model)
          : [];
        persist("AGENTS_DEFAULT_MODEL_CHAIN", JSON.stringify(cleaned));
        config.agents.defaultModelChain = cleaned;
      }
      const webIntelLlm = field("webIntelLlm");
      if (webIntelLlm !== undefined) {
        persist("WEBINTEL_DEFAULT_LLM", webIntelLlm);
        config.webIntel.defaultLlm = webIntelLlm;
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
                events.emit("config:changed", { key, value, updatedBy: "user" });
              }
            }
          }
        }

        // Hot-reload LLM providers so Chat, Agents AND the llm() singleton
        // (EmailTriage, comms, analysis — anything using the standalone client)
        // pick up key changes + chain changes without a restart.
        if (PROVIDER_KEYS.some((k) => k in envUpdates)) {
          if (chatService) chatService.reloadProviders();
          if (agentExecutor) {
            const newProviders = createChatProviders({ claudeCode: config.claudeCode });
            agentExecutor.setProviders(newProviders, config.agents.defaultProvider || config.chat.defaultProvider);
          }
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
    },

    // Probes each provider via the registry's `listModels()`.
    "config.ai.test": async () => {
      if (!llmRegistry) throw new HttpError(503, "llmRegistry not wired");
      const { testAllProviders } = await import("../../core/llm/test-providers.js");
      return testAllProviders(llmRegistry);
    },

    // Agents with their LLM assignment. No table yet (agents module not
    // migrated) is an empty list, not an error.
    "config.ai.agents": () => {
      try {
        if (!db) return { agents: [] };
        const agents = db.prepare(
          "SELECT id, name, description, provider, model, active, builtin_handler FROM agents WHERE active = 1 ORDER BY name"
        ).all();
        return { agents };
      } catch {
        return { agents: [] };
      }
    },

    "config.ai.agents.update": (input) => {
      if (!db) throw new HttpError(500, "DB not available");
      const { agent_id, provider = "", model = "" } = pickArgs(input, { agent_id: "string", provider: "string", model: "string" });
      if (!agent_id) throw new HttpError(400, "agent_id required");
      db.prepare("UPDATE agents SET provider = ?, model = ?, updated_at = datetime('now') WHERE id = ?")
        .run(provider, model, agent_id);
      return { success: true };
    },
  };
}

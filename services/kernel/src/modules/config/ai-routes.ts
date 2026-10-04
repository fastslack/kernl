/**
 * AI Providers Configuration Routes
 *
 * GET  /api/config/ai  — Returns current provider status (keys masked, models, defaults)
 * POST /api/config/ai  — Saves new key/model settings to .env + updates process.env in-memory
 *
 * The routes the dashboard also reaches over the WS RPC (`config.ai.*`) are
 * operations shared with it: see ai-operations.ts.
 */

import { resolve } from "node:path";
import { HttpError, type KernelHttpServer, type RouteMethod } from "../../core/http-server.js";
import type { KernelConfig } from "../../core/config.js";
import type { EventBus } from "../../core/event-bus.js";
import { log } from "../../core/logger.js";
import type { ChatService } from "../chat/service.js";
import type { AgentExecutor } from "../agents/executor.js";
import type { ConfigService } from "./service.js";
import { getProviderConfig } from "../../core/llm/credentials.js";
import { aiConfigOperations, maskKey, writeEnvFile } from "./ai-operations.js";

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

  // ── Operations shared with the WS RPC (ai-operations.ts) ─────────
  // The dashboard reaches these through rpcOrCall, WS first and HTTP when
  // the bridge is down, so both roads run the same function.
  const op = aiConfigOperations({ config, chatService, agentExecutor, events, db, llmRegistry, configService });
  const bind = ([method, path, name]: [RouteMethod, string, string]) => server.operation(method, path, op[name]);
  ([
    ["GET", "/api/config/ai", "config.ai.get"],
    ["POST", "/api/config/ai", "config.ai.save"],
    ["GET", "/api/config/ai/test", "config.ai.test"],
    ["GET", "/api/config/ai/agents", "config.ai.agents"],
    ["POST", "/api/config/ai/agents/update", "config.ai.agents.update"],
  ] as Array<[RouteMethod, string, string]>).forEach(bind);

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

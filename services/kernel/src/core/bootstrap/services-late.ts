/**
 * Stage: late services that depend on every prior stage being up.
 *
 *  - Voice service (STT/TTS).
 *  - RateLimiter (wrapped to fire-and-forget Rust delegate when available).
 *  - Orchestrator (central message router; sees the final tool catalog).
 *  - `notificationRegistry.startAll()` — instantiates the active providers
 *    from `marketplace_items WHERE type='channel' AND status='active'`.
 *  - `wireMessageRouting` — connects every channel provider to the
 *    Orchestrator using the SAME `pairingManager` that backed the HTTP
 *    admin endpoints earlier.
 */

import { log } from "../logger.js";
import type { KernelConfig } from "../config.js";
import type { SqliteDb } from "../db/sqlite.js";
import type { Neo4jClient } from "../db/neo4j.js";
import type { EventBus } from "../event-bus.js";
import type { Notifier } from "../notify/notifier.js";
import type { ModuleRegistry } from "../module-registry.js";
import type { NotificationRegistry } from "../notify/registry.js";
import type { createRustDelegates } from "../rust/delegates.js";
import type { DbDriverRegistry } from "../db-drivers/db-driver-registry.js";
import { Orchestrator } from "../orchestrator.js";
import { wireMessageRouting } from "../message-routing.js";
import { VoiceService } from "../../voice/index.js";
import { RateLimiter, type PairingManager } from "../../security/index.js";

export interface ServicesLateResult {
  voiceService: VoiceService | null;
  rateLimiter: RateLimiter;
  orchestrator: Orchestrator;
}

export async function wireServicesLate(args: {
  config: KernelConfig;
  sqlite: SqliteDb;
  neo4j: Neo4jClient;
  events: EventBus;
  notifier: Notifier;
  registry: ModuleRegistry;
  notificationRegistry: NotificationRegistry;
  dbRegistry: DbDriverRegistry;
  pairingManager: PairingManager;
  rustDelegates: ReturnType<typeof createRustDelegates> | null;
  chatService: unknown;
  agentService: unknown;
  agentExecutor: unknown;
}): Promise<ServicesLateResult> {
  const {
    config, sqlite, neo4j, events, notifier,
    registry, notificationRegistry, dbRegistry, pairingManager,
    rustDelegates,
    chatService, agentService, agentExecutor,
  } = args;

  // ── Voice Service (STT/TTS) ────────────────────────
  let voiceService: VoiceService | null = null;
  if (config.voice.enabled) {
    try {
      voiceService = new VoiceService({
        stt: {
          provider: config.voice.sttProvider,
          openaiApiKey: config.voice.openaiApiKey,
          localWhisperPath: config.voice.localWhisperPath,
        },
        tts: {
          provider: config.voice.ttsProvider,
          elevenLabsApiKey: config.voice.elevenLabsApiKey,
          openaiApiKey: config.voice.openaiApiKey,
          defaultVoice: {
            voiceId: config.voice.defaultVoiceId,
            name: config.voice.defaultVoiceId,
          },
        },
      });
      log.info(`Voice service initialized (STT: ${config.voice.sttProvider}, TTS: ${config.voice.ttsProvider})`);
    } catch (err) {
      log.error("Failed to initialize voice service", err);
    }
  }

  // ── Rate Limiter (security) ────────────────────────
  const rateLimiter = new RateLimiter({ rateLimitWindow: 60 });
  if (rustDelegates && rateLimiter) {
    const rustSecurity = rustDelegates.security;
    // Fire-and-forget Rust rate limit sync (non-blocking, best-effort).
    const originalRecord = rateLimiter.record.bind(rateLimiter);
    rateLimiter.record = (platform: string, userId: string) => {
      originalRecord(platform, userId);
      rustSecurity.rateLimitConsume(`${platform}:${userId}`).catch(() => {});
    };
    log.info("Rate limiting delegated to Rust (with local fallback)");
  }

  // ── Orchestrator (central message router) ──────────
  const orchestrator = new Orchestrator(
    sqlite,
    neo4j,
    () => dbRegistry.getGraph(),
    chatService as ConstructorParameters<typeof Orchestrator>[3],
    notifier,
    registry.getAllTools(),
  );

  // ── Start all active channel providers from marketplace config ──
  await notificationRegistry.startAll();

  // Wire all channel providers (Telegram, WhatsApp, Slack, Discord, WebChat) to Orchestrator.
  wireMessageRouting({
    notificationRegistry,
    orchestrator,
    rateLimiter,
    pairingManager,
    agentService: agentService as Parameters<typeof wireMessageRouting>[0]["agentService"],
    agentExecutor: agentExecutor as Parameters<typeof wireMessageRouting>[0]["agentExecutor"],
    events,
  });

  const activeProviders = notificationRegistry.getStatuses().filter((s) => s.connected);
  if (activeProviders.length > 0) {
    log.info(`NotificationRegistry: ${activeProviders.length} active providers: ${activeProviders.map((s) => s.id).join(", ")}`);
  }

  void voiceService; // exported but currently only held for future hooks
  return { voiceService, rateLimiter, orchestrator };
}

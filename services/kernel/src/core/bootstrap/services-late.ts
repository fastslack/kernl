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

  // ── Circuit breaker → operator ─────────────────────
  // AgentService.recordRunOutcome() emits `agent:auto_paused` when it stops an
  // agent that keeps failing. Until now nothing listened: the only trace was a
  // message dropped in the top agent's thread, which you see only if you go
  // looking. An agent the kernel silently switched off is exactly the thing you
  // find out about days later, so it goes to the dashboard bell.
  //
  // The event already fires ONCE, on the transition into the paused state — a
  // dead upstream must not notify every 15 minutes — so there is no throttling
  // to do here.
  events.on("agent:auto_paused" as never, (p: never) => {
    const e = p as unknown as {
      agent_name?: string;
      consecutive_failures?: number;
      reason?: string;
    };
    const name = e.agent_name || "An agent";
    const fails = e.consecutive_failures ?? 0;
    void notifier
      .send({
        title: `${name} was auto-paused`,
        body:
          `${fails} consecutive failures. Last error: ${(e.reason || "unknown").slice(0, 300)}\n\n` +
          `Its schedule and event triggers are off. Fix the cause, then Resume it from /agents-flow.`,
        channel: "dashboard",
        priority: "high",
        source: "agents",
      })
      .catch((err) => {
        // Never let a failed alert become a second failure on top of the one
        // being reported — the pause itself already succeeded.
        log.warn(`Auto-pause notification for "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  });

  // ── Agents asking the operator → the bell ──────────
  // An agent blocked on a question is waiting on a human who has no idea. The
  // question panel only helps someone already looking at it, so route these
  // the same way as an auto-pause. Scoped to questions on purpose: they are
  // addressed to a person by construction, while agent-to-agent messages are
  // constant and would drown the bell.
  events.on("agent:question_asked" as never, (p: never) => {
    const e = p as unknown as {
      agent_name?: string;
      question?: string;
      options?: string[];
    };
    const name = e.agent_name || "An agent";
    const opts = e.options ?? [];
    void notifier
      .send({
        title: `${name} needs an answer`,
        body:
          `${(e.question || "").slice(0, 400)}` +
          (opts.length ? `\n\nOptions: ${opts.join(" · ")}` : "") +
          `\n\nAnswer it from /agents-flow.`,
        channel: "dashboard",
        priority: "normal",
        source: "agents",
      })
      .catch((err) => {
        log.warn(`Question notification from "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  });

  void voiceService; // exported but currently only held for future hooks
  return { voiceService, rateLimiter, orchestrator };
}

/**
 * Stage: late services that depend on every prior stage being up.
 *
 *  - Voice service (STT/TTS) and its /api/voice/* routes.
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
import { HttpError, type KernelHttpServer } from "../http-server.js";
import { OperatorComms } from "../operator-comms/driver.js";
import { buildAdapters } from "../operator-comms/adapters.js";
import { resolveHumanChoice } from "../../modules/agents/question-delivery.js";
import type { AgentService } from "../../modules/agents/service.js";
import type { AgentExecutor } from "../../modules/agents/executor.js";
import { VoiceService, registerVoiceRoutes } from "../../voice/index.js";
import { RateLimiter, type PairingManager } from "../../security/index.js";

export interface ServicesLateResult {
  voiceService: VoiceService;
  rateLimiter: RateLimiter;
  orchestrator: Orchestrator;
  operatorComms: OperatorComms | null;
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
  httpServer: KernelHttpServer | null;
}): Promise<ServicesLateResult> {
  const {
    config, sqlite, neo4j, events, notifier,
    registry, notificationRegistry, dbRegistry, pairingManager,
    rustDelegates,
    chatService, agentService, agentExecutor, httpServer,
  } = args;

  // ── Voice Service (STT/TTS) ────────────────────────
  // Always built: it reads config.voice on every call, so turning voice on in
  // Settings works without a restart. The routes answer 409 while it is off.
  const voiceService = new VoiceService(config);
  if (httpServer) registerVoiceRoutes(httpServer, voiceService);
  log.info(`Voice service ready (enabled: ${config.voice.enabled}, STT: ${config.voice.sttEngine}, TTS: ${config.voice.ttsEngine})`);

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

  // The one driver for operator decisions (spec 2026-10-14): built before the
  // channels are wired because inbound replies/callbacks go through it.
  const operatorComms = agentService && agentExecutor ? new OperatorComms({
    db: sqlite,
    service: agentService as AgentService,
    adapters: () => buildAdapters({
      list: () => notificationRegistry.getProviderIds().map((id) => notificationRegistry.getProvider(id)).filter(Boolean) as never,
    }),
    preference: () => (process.env.OPERATOR_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    dashboard: async (n) => {
      await notifier.send({ title: n.title, body: n.body, channel: "dashboard", priority: n.priority, source: "agents" });
    },
    answer: (id, choice) =>
      resolveHumanChoice(agentService as AgentService, agentExecutor as AgentExecutor, events, id, choice),
    linkFor: (id) => `/agents-flow?question=${id}`,
  }) : null;

  // Wire all channel providers (Telegram, WhatsApp, Slack, Discord, WebChat) to Orchestrator.
  wireMessageRouting({
    notificationRegistry,
    orchestrator,
    rateLimiter,
    pairingManager,
    agentService: agentService as Parameters<typeof wireMessageRouting>[0]["agentService"],
    agentExecutor: agentExecutor as Parameters<typeof wireMessageRouting>[0]["agentExecutor"],
    events,
    voiceService,
    operatorComms,
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

  // ── Operator decisions → one driver (spec 2026-10-14) ──
  const safe = (what: string, p: Promise<void>) =>
    p.catch((err) => log.warn(`operator-comms ${what}: ${err instanceof Error ? err.message : String(err)}`));
  if (operatorComms) events.on("agent:question_asked" as never, ((p: { question_id: string }) => safe("ask", operatorComms.ask(p.question_id))) as never);
  if (operatorComms) events.on("agent:question_owed" as never, ((p: { question_id: string }) => safe("owed", operatorComms.owed(p.question_id))) as never);
  if (operatorComms) events.on("agent:question_remind" as never, ((p: { question_id: string }) => safe("remind", operatorComms.remind(p.question_id))) as never);
  if (operatorComms) events.on("agent:question_resolved" as never, ((p: { question_id: string }) => safe("resolved", operatorComms.resolved(p.question_id))) as never);

  // Offices and agents can tell the operator something without asking anything.
  // Registered here (not in the agents routes) because the driver only exists
  // once the channels are up, after the HTTP routes were registered.
  httpServer?.route<{ title?: string; body?: string; source?: string }>("POST", "/api/operator/inform", ({ body }) => {
    const title = String(body?.title ?? "").trim().slice(0, 200);
    if (!operatorComms) throw new HttpError(503, "operator comms unavailable");
    if (!title) throw new HttpError(400, "title required");
    void safe("inform", operatorComms.inform({ title, body: String(body?.body ?? "").slice(0, 4000), source: String(body?.source ?? "office") }));
    return { success: true };
  });

  return { voiceService, rateLimiter, orchestrator, operatorComms };
}

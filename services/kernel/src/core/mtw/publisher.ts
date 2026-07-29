/**
 * mtwRequest Publisher — connects to mtwRequest via the official SDK
 * and publishes dashboard data to channels.
 *
 * When Kernl's EventBus fires "data.changed", this publisher
 * queries the fresh data and publishes it to the corresponding
 * mtwRequest channel. The browser subscribes to those channels
 * via @matware/mtw-request-svelte.
 *
 * Flow:
 *   Tool call → data.changed event → Publisher queries fresh data
 *   → Publishes to mtwRequest channel → Rust broadcasts to browsers
 */

import { MtwConnection, createMessage, jsonPayload, emptyPayload } from "@matware/mtw-request-ts-client";
import { log } from "../logger.js";
import type { EventBus } from "../event-bus.js";

interface PublisherOptions {
  /** Shared MtwConnection (managed externally) */
  conn: MtwConnection;
  /** EventBus to listen for data changes */
  events: EventBus;
  /** Function that returns fresh data for a channel */
  queryChannel: (channel: string) => Promise<unknown>;
  /**
   * Enable the 15s publishAll(ALL_CHANNELS) refresh loop.
   *
   * MUST be false on stdio-only kernels (one per Claude session): nobody is
   * watching dashboard channels there, and each refresh cycle full-scans
   * kernel.db (multi-GB) — measured at ~80% of a core, permanently, per
   * kernel. Same class of bug as the trading-engine autostart. On-demand
   * publishes (data.changed → schedulePublish) still work either way.
   */
  periodicRefresh?: boolean;
}

/** All channels the publisher subscribes to and refreshes */
/** Essential channels — always pushed on connect + periodic refresh */
const ESSENTIAL_CHANNELS = [
  "dashboard", "notifications",
];

/** All channels — subscribed for data.changed routing, pushed periodically */
const ALL_CHANNELS = [
  "dashboard", "analytics", "agenda", "calendar",
  "life", "agents", "agents.flow", "notifications",
  "system", "crossIntel", "systemAgenda", "trading", "trading-ticker",
  "finance", "health", "notes", "learning",
];

// Compat alias
const CHANNELS = ALL_CHANNELS;

export class MtwPublisher {
  private conn: MtwConnection;
  private events: EventBus;
  private queryChannel: (channel: string) => Promise<unknown>;
  private connected = false;
  private shuttingDown = false;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private periodicRefresh: boolean;

  constructor(opts: PublisherOptions) {
    this.conn = opts.conn;
    this.events = opts.events;
    this.queryChannel = opts.queryChannel;
    this.periodicRefresh = opts.periodicRefresh ?? true;
  }

  async start(): Promise<void> {
    this.shuttingDown = false;
    log.debug(`Publisher: start() entered, conn.connected=${this.conn.connected}`);

    // Register handlers — connection lifecycle is managed externally
    this.conn.on("connected", () => {
      this.connected = true;
      log.info("Publisher: connected to mtwRequest");
      this.onConnected();
    });

    this.conn.on("reconnected", () => {
      this.connected = true;
      log.info("Publisher: reconnected to mtwRequest");
      this.onConnected();
    });

    this.conn.on("disconnected", () => {
      this.connected = false;
      log.debug("Publisher: disconnected (SDK will auto-reconnect)");
    });

    this.conn.on("error", (err: unknown) => {
      log.debug(`Publisher: error — ${err}`);
    });

    // Listen for data changes and publish to mtwRequest channels
    this.events.on("data.changed" as any, (payload: any) => {
      const module = payload?.module ?? "unknown";
      if (!this.connected) return;
      this.schedulePublish(module);

      // Emit arch beam for the 3D architecture view (tool calls only, not every tick)
      const tool = payload?.tool ?? "";
      if (tool) {
        const target = tool.replace(/^kernel_/, "").split("_")[0];
        this.publishEvent("agents.flow", "archEvent", {
          event: "tool_exec",
          data: { source: "mcp", target: target || module, module, tool },
          ts: new Date().toISOString(),
        });
      }
    });

    // Forward trade executions to the 3D office as a special event
    this.events.on("trading:order_placed" as any, (payload: any) => {
      if (!this.connected) return;
      this.publishEvent("agents.flow", "archEvent", {
        event: "trade_executed",
        data: {
          trade_id: payload?.trade_id,
          symbol: payload?.symbol,
          side: payload?.side,
          amount: payload?.amount,
          price: payload?.price,
          status: payload?.status,
        },
        ts: new Date().toISOString(),
      });
    });

    // If already connected (connection started before publisher), trigger initial push
    if (this.conn.connected) {
      this.connected = true;
      log.info("Publisher: connected to mtwRequest (already-open connection)");
      this.onConnected();
    } else {
      log.debug(`Publisher: waiting for mtwRequest connection (connected=${this.conn.connected})`);
    }
  }

  /** Slow channels that block — pushed after fast ones */
  private static readonly SLOW_CHANNELS = new Set(["analytics", "crossIntel"]);

  /** Called on every (re)connection — subscribe + initial publish */
  private onConnected(): void {
    for (const ch of CHANNELS) {
      this.conn.send(
        createMessage("subscribe", emptyPayload(), { channel: ch }),
      );
    }

    if (!this.periodicRefresh) {
      // stdio-only kernel: push the cheap essentials once and stay quiet.
      // No ALL_CHANNELS scan, no 15s loop — see PublisherOptions.periodicRefresh.
      setTimeout(() => this.publishAll(ESSENTIAL_CHANNELS), 500);
      log.info("Publisher: periodic refresh disabled (stdio transport)");
      return;
    }

    // Push all channels on connect — essential first, rest immediately after
    setTimeout(() => this.publishAll(ALL_CHANNELS), 500);

    // Periodic refresh every 15s
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshInterval = setInterval(() => this.publishAll(ALL_CHANNELS), 15000);
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    // Connection is managed externally — don't close it here
    this.connected = false;
    log.info("Publisher: shut down");
  }

  /** Publish raw data to a mtwRequest channel */
  publish(channel: string, data: unknown): void {
    if (!this.connected) return;
    try {
      this.conn.send(
        createMessage("publish", jsonPayload(data), { channel }),
      );
    } catch (err) {
      log.warn(`Publisher: failed to publish to ${channel}`, err);
    }
  }

  /** Publish a special event (agentFlow, archEvent, notification) */
  publishEvent(channel: string, eventType: string, eventData: unknown): void {
    if (!this.connected) {
      log.debug(`Publisher: skipped (offline) ch=${channel} type=${eventType}`);
      return;
    }
    try {
      this.conn.send(
        createMessage("publish", jsonPayload({ type: eventType, ...eventData as Record<string, unknown> }), { channel }),
      );
      if (eventType === "agentFlow") {
        const evtName = (eventData as { event?: string })?.event ?? "?";
        log.debug(`Publisher: sent ch=${channel} type=${eventType} event=${evtName}`);
      } else {
        log.debug(`Publisher: sent ch=${channel} type=${eventType}`);
      }
    } catch (err) {
      log.warn(`Publisher: failed to send ch=${channel} type=${eventType} — ${err}`);
    }
  }

  /** Debounce publish per module (500ms) */
  private schedulePublish(module: string): void {
    const existing = this.debounceTimers.get(module);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      module,
      setTimeout(async () => {
        this.debounceTimers.delete(module);
        await this.doPublish(module);
      }, 500),
    );
  }

  /** Max time to wait for a single channel query before skipping */
  private static readonly CHANNEL_TIMEOUT_MS = 3000;

  /** Publish all channels — fast channels first, slow channels with timeout */
  private async publishAll(channels: string[]): Promise<void> {
    const totalStart = Date.now();
    let pushed = 0;

    // Publish all channels concurrently with per-channel timeout
    const results = await Promise.allSettled(
      channels.map(async (channel) => {
        const t0 = Date.now();
        try {
          const data = await Promise.race([
            this.queryChannel(channel),
            new Promise<undefined>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), MtwPublisher.CHANNEL_TIMEOUT_MS),
            ),
          ]);
          const ms = Date.now() - t0;
          if (data !== undefined && data !== null) {
            const size = JSON.stringify(data).length;
            if (ms > 500 || size > 100000) {
              log.warn(`Publisher: channel=${channel} ${ms}ms, ${(size / 1024).toFixed(1)}KB`);
            }
            this.publish(channel, data);
            return true;
          }
        } catch (err) {
          const ms = Date.now() - t0;
          log.warn(`Publisher: channel=${channel} SKIPPED after ${ms}ms — ${err instanceof Error ? err.message : "error"}`);
        }
        return false;
      }),
    );

    pushed = results.filter(r => r.status === "fulfilled" && r.value === true).length;
    log.info(`Publisher: pushed ${pushed}/${channels.length} channels in ${Date.now() - totalStart}ms`);
  }

  private async doPublish(module: string): Promise<void> {
    const channelsForModule = MODULE_CHANNEL_MAP[module] ?? [module];
    log.debug(`Publisher: publishing module=${module} → channels=[${channelsForModule.join(",")}]`);

    for (const channel of channelsForModule) {
      try {
        const freshData = await this.queryChannel(channel);
        if (freshData !== undefined && freshData !== null) {
          this.publish(channel, freshData);
        }
      } catch (err) {
        log.debug(`Publisher: failed to query channel ${channel}: ${err}`);
      }
    }
  }
}

/** Module → mtwRequest channel mapping */
const MODULE_CHANNEL_MAP: Record<string, string[]> = {
  tasks: ["dashboard", "agenda", "calendar"],
  crm: ["dashboard", "analytics"],
  reminders: ["dashboard", "agenda"],
  shopping: ["dashboard"],
  home: ["dashboard"],
  issues: ["dashboard"],
  subscriptions: ["dashboard"],
  finance: ["dashboard", "finance"],
  notes: ["dashboard", "notes"],
  goals: ["dashboard"],
  vehicles: ["dashboard"],
  meals: ["dashboard"],
  documents: ["dashboard"],
  health: ["dashboard", "health"],
  events: ["dashboard", "calendar"],
  training: ["dashboard"],
  nutrition: ["dashboard"],
  calendar: ["calendar"],
  agents: ["agents"],
  chat: ["dashboard"],
  trading: ["trading", "trading-ticker"],
  comms: ["dashboard"],
  "time-tracking": ["dashboard"],
  learning: ["dashboard", "learning"],
  travel: ["dashboard"],
  "trading-ticker": ["trading"],
};

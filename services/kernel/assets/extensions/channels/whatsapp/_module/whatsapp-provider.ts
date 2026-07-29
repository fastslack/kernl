/**
 * WhatsApp provider backed by mtwRequest.
 *
 * The kernel no longer embeds a WhatsApp client directly. All outbound
 * messages are forwarded as `whatsapp.send_*` request actions to mtwRequest,
 * which dispatches them through the `whatsapp-bridge` Go sidecar over a
 * Unix socket. Inbound messages, QR codes and lifecycle events arrive on
 * the mtwRequest channels `whatsapp:inbound`, `whatsapp:qr`, `whatsapp:status`.
 *
 * This file is a thin client — no Baileys, no Puppeteer, no
 * `whatsapp-web.js`. The shared `MtwConnection` instance is injected via
 * `setMtwConnection()` at bootstrap so the factory registration can stay
 * dependency-free.
 */

import { log } from "../../../../../src/core/logger.js";
import type {
  NotificationProvider,
  NotificationPayload,
  ProviderStatus,
  ProviderCapability,
  ConfigField,
} from "../../../../../src/core/notify/provider.js";
import type {
  MtwConnection,
  MtwMessage,
  Unsubscribe,
} from "@matware/mtw-request-ts-client";

// ── Shared connection injection ──────────────────────────────────────

let sharedConn: MtwConnection | null = null;

/**
 * Supply the WhatsApp provider with the kernel-wide MtwConnection. Must
 * be called before `start()` on any provider instance; otherwise the
 * provider reports `error: "mtwRequest not configured"` and refuses to
 * send.
 */
export function setMtwConnection(conn: MtwConnection | null): void {
  sharedConn = conn;
}

// ── Channel names (must match mtwRequest's mtw-server/src/whatsapp.rs) ───

const CHANNEL_INBOUND = "whatsapp:inbound";
const CHANNEL_QR = "whatsapp:qr";
const CHANNEL_STATUS = "whatsapp:status";

// ── Event payloads we receive from mtwRequest ────────────────────────

type StatusPayload =
  | { state: "ready" }
  | { state: "paired"; jid?: string | null }
  | { state: "connected"; jid?: string | null }
  | { state: "disconnected"; reason?: string }
  | { state: "ack"; id?: string; message_id?: string | null }
  | { state: "error"; id?: string | null; code?: string | null; message?: string };

interface QrPayload { code: string; }

interface InboundAttachment {
  kind: "image" | "video" | "audio" | "voice" | "document";
  mime: string;
  filename?: string | null;
  data_b64: string;
  caption?: string | null;
}

export interface InboundPayload {
  id: string;
  from: string;
  chat: string;
  is_group: boolean;
  group_name?: string | null;
  author: string;
  push_name?: string | null;
  timestamp: number;
  text: string;
  reply_to?: string | null;
  attachments: InboundAttachment[];
}

// ── Provider ─────────────────────────────────────────────────────────

export class WhatsAppProvider implements NotificationProvider {
  readonly id = "whatsapp";
  readonly name = "WhatsApp";
  readonly icon = "📱";
  readonly capabilities: ProviderCapability[] = ["notify", "receive", "media", "reactions"];

  private config: Record<string, unknown> = {};
  private currentQr: string | null = null;
  private connectedJid: string | null = null;
  private lastError: string | undefined;
  private unsubscribers: Unsubscribe[] = [];

  /** Optional listener for inbound messages — set by the comms routing layer. */
  private onInbound: ((msg: InboundPayload) => Promise<void> | void) | null = null;

  /**
   * Instance pass-through for the module-level `setMtwConnection`. The
   * bootstrap calls this via `NotificationRegistry.registerPreStartHook`
   * so we don't need to dynamic-import this module from core/. The
   * module-scoped `sharedConn` stays the source of truth because the
   * outbound + inbound helpers above already read it.
   */
  setMtwConnection(conn: MtwConnection | null): void {
    setMtwConnection(conn);
  }

  getConfigSchema(): ConfigField[] {
    return [
      {
        key: "allowedNumbers",
        label: "Allowed Numbers",
        type: "textarea",
        required: false,
        placeholder: "34612345678,34698765432",
        description: "Comma-separated phone numbers. Empty = no one; use '*' to allow everyone.",
      },
      {
        key: "defaultChat",
        label: "Default Chat",
        type: "text",
        required: false,
        placeholder: "34612345678@s.whatsapp.net",
        description: "JID for proactive notifications (sendNotification target).",
      },
    ];
  }

  validateConfig(_config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    // WhatsApp doesn't need API keys — pairing is QR-based via the sidecar.
    return { valid: true };
  }

  configure(config: Record<string, unknown>): void {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!sharedConn) {
      this.lastError = "mtwRequest connection not configured (setMtwConnection never called)";
      log.warn(`WhatsApp: ${this.lastError}`);
      return;
    }

    // Subscribe to lifecycle / QR / inbound channels. We rely on
    // mtwRequest's create-on-publish behaviour so we don't need to
    // declare these channels server-side; the WhatsApp integration
    // already creates them when the bridge is enabled.
    const conn = sharedConn;

    this.unsubscribers.push(
      conn.onChannel(CHANNEL_QR, (msg) => this.handleQr(msg)),
      conn.onChannel(CHANNEL_STATUS, (msg) => this.handleStatus(msg)),
      conn.onChannel(CHANNEL_INBOUND, (msg) => this.handleInbound(msg)),
    );

    // Subscribe explicitly so mtwRequest starts forwarding events.
    try {
      const { createMessage, emptyPayload } = await import("@matware/mtw-request-ts-client");
      for (const ch of [CHANNEL_QR, CHANNEL_STATUS, CHANNEL_INBOUND]) {
        conn.send(createMessage("subscribe", emptyPayload(), { channel: ch }));
      }
    } catch (err) {
      this.lastError = `subscribe failed: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(`WhatsApp: ${this.lastError}`);
    }

    this.lastError = undefined;
    log.info("WhatsApp: provider bound to mtwRequest channels");
  }

  async stop(): Promise<void> {
    for (const off of this.unsubscribers) {
      try { off(); } catch { /* best-effort */ }
    }
    this.unsubscribers = [];
    this.currentQr = null;
    this.connectedJid = null;
  }

  isReady(): boolean {
    return sharedConn !== null && sharedConn.connected && this.connectedJid !== null;
  }

  getStatus(): ProviderStatus {
    return {
      id: this.id,
      name: this.name,
      icon: this.icon,
      connected: this.isReady(),
      enabled: true,
      error: this.lastError,
      capabilities: this.capabilities,
      info: {
        phoneNumber: this.connectedJid ? this.connectedJid.split("@")[0].split(":")[0] : undefined,
        qr: this.currentQr,
      },
    };
  }

  /** Current QR code string (null when already paired or no pairing requested). */
  getQr(): string | null {
    return this.currentQr;
  }

  /** Register a handler for inbound WhatsApp messages. */
  setInboundHandler(fn: ((msg: InboundPayload) => Promise<void> | void) | null): void {
    this.onInbound = fn;
  }

  async sendNotification(payload: NotificationPayload): Promise<boolean> {
    const chat = (this.config.defaultChat as string) || "";
    if (!chat) {
      log.warn("WhatsApp: no default chat configured");
      return false;
    }
    return this.sendTo(chat, payload);
  }

  async sendTo(target: string, payload: NotificationPayload): Promise<boolean> {
    if (!sharedConn || !sharedConn.connected) {
      this.lastError = "mtwRequest not connected";
      return false;
    }
    const text = this.formatPayload(payload);
    return this.dispatchAction("whatsapp.send_text", { to: target, text });
  }

  async sendTest(): Promise<boolean> {
    return this.sendNotification({
      title: "Kernl — WhatsApp test",
      body: "WhatsApp notification channel working via mtwRequest!",
    });
  }

  /** Force a fresh QR cycle (useful if the current code expired). */
  async requestQr(): Promise<boolean> {
    return this.dispatchAction("whatsapp.request_qr", {});
  }

  /** End the WhatsApp session on the sidecar. Next boot will require a QR scan. */
  async logout(): Promise<boolean> {
    return this.dispatchAction("whatsapp.logout", {});
  }

  // ── internals ─────────────────────────────────────────────────────

  private async dispatchAction(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    if (!sharedConn || !sharedConn.connected) return false;
    try {
      const { createMessage, jsonPayload } = await import("@matware/mtw-request-ts-client");
      // mtwRequest routes whatsapp.* actions via `metadata.action`
      // (see mtw-server/src/whatsapp.rs and main.rs handle_request).
      const req = createMessage("request", jsonPayload(payload), { metadata: { action } });
      const resp = await sharedConn.request(req, 15_000);
      if (resp.type === "error") {
        this.lastError = this.readErrorMessage(resp);
        log.warn(`WhatsApp: ${action} failed — ${this.lastError}`);
        return false;
      }
      this.lastError = undefined;
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      log.warn(`WhatsApp: ${action} threw — ${this.lastError}`);
      return false;
    }
  }

  private readErrorMessage(msg: MtwMessage): string {
    const payload = msg.payload as unknown;
    if (payload && typeof payload === "object") {
      const j = (payload as { json?: unknown }).json;
      if (j && typeof j === "object" && "message" in j) {
        return String((j as { message: unknown }).message);
      }
    }
    return "unknown error";
  }

  private extractJson<T>(msg: MtwMessage): T | null {
    // mtwRequest serializes `Payload::Json(v)` as `{ kind: "Json", data: v }`
    // on the wire. The TS SDK keeps the same shape.
    const payload = msg.payload as unknown;
    if (!payload || typeof payload !== "object") return null;
    const p = payload as { kind?: string; data?: unknown; json?: unknown };
    if (p.kind === "Json" && p.data && typeof p.data === "object") {
      return p.data as T;
    }
    // Tolerate older `{ json: {...} }` shape too.
    if (p.json && typeof p.json === "object") return p.json as T;
    return null;
  }

  private handleQr(msg: MtwMessage): void {
    const data = this.extractJson<QrPayload>(msg);
    if (!data?.code) return;
    this.currentQr = data.code;
    log.info(`WhatsApp: QR code received (${data.code.slice(0, 10)}…) — scan from the dashboard.`);
  }

  private handleStatus(msg: MtwMessage): void {
    const data = this.extractJson<StatusPayload>(msg);
    if (!data) return;

    switch (data.state) {
      case "connected":
        this.connectedJid = data.jid ?? null;
        this.currentQr = null;
        this.lastError = undefined;
        log.info(`WhatsApp: connected (${this.connectedJid ?? "unknown"})`);
        break;
      case "paired":
        log.info("WhatsApp: device paired");
        break;
      case "disconnected":
        this.connectedJid = null;
        log.warn(`WhatsApp: disconnected — ${data.reason ?? ""}`);
        break;
      case "error":
        this.lastError = data.message ?? "";
        log.warn(`WhatsApp: error — ${this.lastError}`);
        break;
      default:
        // "ready", "ack" — informational only
        break;
    }
  }

  private async handleInbound(msg: MtwMessage): Promise<void> {
    const data = this.extractJson<InboundPayload>(msg);
    if (!data) return;

    if (!this.isAllowed(data.author)) {
      log.warn(`WhatsApp: dropped inbound from unauthorized sender ${data.author}`);
      return;
    }

    if (this.onInbound) {
      try {
        await this.onInbound(data);
      } catch (err) {
        log.error("WhatsApp: inbound handler threw", err);
      }
    }
  }

  private isAllowed(sender: string): boolean {
    const raw = (this.config.allowedNumbers as string | undefined) ?? "";
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) return false;
    if (list.includes("*")) return true;
    // Exact digit-match only. The previous bidirectional `includes` let any
    // number that was a substring of (or superstring containing) an allowlisted
    // number pass the gate — a full auth bypass, since the allowlist is the SOLE
    // trust gate for WhatsApp (no pairing flow). Normalize away +/space/dashes.
    const phone = sender.split("@")[0].split(":")[0].replace(/\D/g, "");
    return list.some((n) => n.replace(/\D/g, "") === phone);
  }

  private formatPayload(payload: NotificationPayload): string {
    const prefix = payload.priority === "high" ? "🚨 " : "";
    const lines = [`${prefix}*${payload.title}*`];
    if (payload.body) lines.push(payload.body);
    return lines.join("\n");
  }
}

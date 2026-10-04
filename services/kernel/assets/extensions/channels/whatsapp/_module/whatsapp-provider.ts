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

import {
  log,
  formatNotification,
  csvList,
  type NotificationProvider,
  type NotificationPayload,
  type ProviderStatus,
  type ProviderCapability,
  type ConfigField,
} from "@kernl/extension-sdk";
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
const CHANNEL_PAIRING = "whatsapp:pairing";

// ── Public shapes ────────────────────────────────────────────────────

export type ActionResult = { ok: boolean; error?: string; code?: string };
export type ChatItem = { jid: string; name: string; is_group: boolean; last_ts: number };
export type WaStatus = {
  bridge_connected: boolean;
  state: string;
  mode?: string;
  jid?: string;
  /** Own LID (`123@lid`) of the linked account, when the bridge knows it. */
  lid?: string;
  reason?: string;
  qr?: string;
  pairing_code?: string;
  pairing_expires_at?: number;
  phoneNumber?: string;
};
/**
 * Saves an auto-config patch. It fills only keys that are empty in the stored
 * config and returns the stored config as it ends up (the provider adopts
 * it); it throws when the save fails.
 */
export type ConfigPersister = (
  patch: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
type RequestResult = { ok: boolean; data?: unknown; error?: string; code?: string };

/**
 * Digits-only phone in international format (country code first, no
 * leading 0, 8-15 digits), or null. `+54 9 11 2345-6789` → `5491123456789`.
 */
export function normalizePhone(raw: string): string | null {
  const s = String(raw ?? "");
  // Letters or other symbols mean a typo: reject instead of dropping them.
  if (!/^[0-9\s+\-().]*$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  return /^[1-9][0-9]{7,14}$/.test(digits) ? digits : null;
}

/** `5491123456789:12@s.whatsapp.net` → `5491123456789`. */
function jidNumber(jid: string): string {
  return String(jid ?? "").split("@")[0].split(":")[0];
}

/** `123:4@lid` → true for a LID address. */
function isLid(jid: string): boolean {
  return String(jid ?? "").endsWith("@lid");
}

/** `549…@s.whatsapp.net` (device suffix allowed) → true for a phone JID. */
function isPhoneJid(jid: string): boolean {
  return String(jid ?? "").endsWith("@s.whatsapp.net");
}

/** Whether `jid` is the LID `lid` (device suffix ignored). */
function sameLid(jid: string, lid: string | null): boolean {
  return lid !== null && isLid(jid) && isLid(lid) && jidNumber(jid) === jidNumber(lid);
}

/** Session states the bridge publishes on `whatsapp:status`. */
const SESSION_STATES = new Set(["idle", "linking", "connected", "disconnected", "logged_out", "unknown"]);

// ── Event payloads we receive from mtwRequest ────────────────────────

// Session states: idle | linking | connected | disconnected | logged_out | unknown.
// `ready`, `paired`, `ack` and `error` now travel on `whatsapp:events`; they
// are still tolerated here for older mtw-server builds.
interface StatusPayload {
  state: string;
  mode?: string | null;
  jid?: string | null;
  lid?: string | null;
  reason?: string | null;
  id?: string | null;
  code?: string | null;
  message?: string | null;
}

interface QrPayload { code: string; }
interface PairingPayload { code: string; expires_at?: number | null; }

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
  /** True when the linked account itself wrote the message (any chat). */
  from_me?: boolean | null;
  /**
   * The sender's other address: its LID when `author` is a phone JID, its
   * phone JID when `author` is a LID. May be absent.
   */
  sender_alt?: string | null;
}

// ── Provider ─────────────────────────────────────────────────────────

export class WhatsAppProvider implements NotificationProvider {
  readonly id = "whatsapp";
  readonly name = "WhatsApp";
  readonly icon = "📱";
  readonly capabilities: ProviderCapability[] = ["notify", "receive", "media", "reactions"];

  private config: Record<string, unknown> = {};
  private currentQr: string | null = null;
  private pairingCode: string | null = null;
  private pairingExpiresAt: number | null = null;
  private connectedJid: string | null = null;
  /** Own LID while connected (optional on the wire; null when unknown). */
  private connectedLid: string | null = null;
  private linkState: string | null = null;
  private linkMode: string | null = null;
  private linkReason: string | null = null;
  private persistConfig: ConfigPersister | null = null;
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

  /**
   * Where auto-config patches go (the kernel wires it to the channel's
   * stored config, see `ConfigPersister`). Without one, patches only live
   * in memory.
   */
  setConfigPersister(fn: ConfigPersister | null): void {
    this.persistConfig = fn;
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
      conn.onChannel(CHANNEL_PAIRING, (msg) => this.handlePairing(msg)),
    );

    // Subscribe explicitly so mtwRequest starts forwarding events.
    try {
      const { createMessage, emptyPayload } = await import("@matware/mtw-request-ts-client");
      for (const ch of [CHANNEL_QR, CHANNEL_STATUS, CHANNEL_INBOUND, CHANNEL_PAIRING]) {
        conn.send(createMessage("subscribe", emptyPayload(), { channel: ch }));
      }
    } catch (err) {
      this.lastError = `subscribe failed: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(`WhatsApp: ${this.lastError}`);
    }

    this.lastError = undefined;

    // Seed the session from the authoritative cache: the channel history can
    // hold a stale message, and `isReady()` must not depend on it.
    try {
      const s = await this.status();
      if (SESSION_STATES.has(s.state)) this.linkState = s.state;
      this.connectedJid = s.state === "connected" ? (s.jid ?? null) : null;
      this.connectedLid = s.state === "connected" && s.lid ? s.lid : null;
    } catch {
      // status() never throws; best-effort anyway.
    }

    log.info("WhatsApp: provider bound to mtwRequest channels");
  }

  async stop(): Promise<void> {
    for (const off of this.unsubscribers) {
      try { off(); } catch { /* best-effort */ }
    }
    this.unsubscribers = [];
    this.currentQr = null;
    this.pairingCode = null;
    this.pairingExpiresAt = null;
    this.connectedJid = null;
    this.connectedLid = null;
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
        phoneNumber: this.connectedJid ? jidNumber(this.connectedJid) : undefined,
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

  /** End the WhatsApp session on the sidecar. The next link needs a fresh QR or code. */
  async logout(): Promise<ActionResult> {
    return this.toAction(await this.request("whatsapp.logout", {}));
  }

  /** Start a QR link; codes arrive on `whatsapp:qr`. */
  async linkQr(): Promise<ActionResult> {
    return this.toAction(await this.request("whatsapp.link_qr", {}));
  }

  /** Start a phone-code link; the code arrives on `whatsapp:pairing`. */
  async linkPhone(phone: string): Promise<ActionResult> {
    const digits = normalizePhone(phone);
    if (!digits) return { ok: false, error: "invalid_phone", code: "invalid_phone" };
    return this.toAction(await this.request("whatsapp.link_phone", { phone: digits }));
  }

  /** Abort a link in progress. */
  async linkCancel(): Promise<ActionResult> {
    const res = this.toAction(await this.request("whatsapp.link_cancel", {}));
    if (res.ok) {
      this.currentQr = null;
      this.pairingCode = null;
      this.pairingExpiresAt = null;
    }
    return res;
  }

  /** Recent chats (groups and contacts) known to the linked session. */
  async listChats(limit = 50): Promise<{ ok: boolean; items: ChatItem[]; error?: string }> {
    const res = await this.request("whatsapp.list_chats", { limit });
    if (!res.ok) return { ok: false, items: [], error: res.error };
    const items = (res.data as { items?: unknown } | undefined)?.items;
    return { ok: true, items: Array.isArray(items) ? (items as ChatItem[]) : [] };
  }

  /** Bridge status merged with what this provider saw on the channels. */
  async status(): Promise<WaStatus> {
    const res = await this.request("whatsapp.status", {});
    if (!res.ok || !res.data || typeof res.data !== "object") {
      return { bridge_connected: false, state: "unknown" };
    }
    const d = res.data as Record<string, unknown>;
    const out: WaStatus = {
      bridge_connected: d.bridge_connected === true,
      state: typeof d.state === "string" ? d.state : (this.linkState ?? "unknown"),
    };
    const str = (v: unknown, local: string | null): string | undefined =>
      typeof v === "string" && v ? v : (local ?? undefined);
    const mode = str(d.mode, this.linkMode);
    const jid = str(d.jid, this.connectedJid);
    const lid = str(d.lid, this.connectedLid);
    const reason = str(d.reason, this.linkReason);
    const qr = str(d.qr, this.currentQr);
    const pairing = str(d.pairing_code, this.pairingCode);
    const expires = typeof d.pairing_expires_at === "number" ? d.pairing_expires_at : this.pairingExpiresAt;
    if (mode) out.mode = mode;
    if (jid) out.jid = jid;
    if (lid && out.state === "connected") out.lid = lid;
    if (reason) out.reason = reason;
    if (qr) out.qr = qr;
    if (pairing) out.pairing_code = pairing;
    if (pairing && typeof expires === "number") out.pairing_expires_at = expires;
    const number = jid ? jidNumber(jid) : null;
    if (number) out.phoneNumber = number;
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────

  /**
   * One request/response round trip with mtwRequest. Errors come back as
   * `{ ok:false, error, code }` (never thrown); a JSON response's body is in
   * `data`.
   */
  private async request(
    action: string,
    payload: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<RequestResult> {
    if (!sharedConn || !sharedConn.connected) {
      return { ok: false, error: "mtwRequest not connected", code: "mtw_not_connected" };
    }
    try {
      const { createMessage, jsonPayload } = await import("@matware/mtw-request-ts-client");
      // mtwRequest routes whatsapp.* actions via `metadata.action`
      // (see mtw-server/src/whatsapp.rs and main.rs handle_request).
      const req = createMessage("request", jsonPayload(payload), { metadata: { action } });
      const resp = await sharedConn.request(req, timeoutMs);
      if (resp.type === "error") {
        const { message, code } = this.readError(resp);
        this.lastError = message;
        // Only the action name and the server's message — never the payload
        // (it can carry a phone number).
        log.warn(`WhatsApp: ${action} failed — ${message}`);
        return { ok: false, error: message, ...(code !== undefined ? { code } : {}) };
      }
      this.lastError = undefined;
      const p = resp.payload as { kind?: string; data?: unknown } | undefined;
      return p?.kind === "Json" ? { ok: true, data: p.data } : { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      log.warn(`WhatsApp: ${action} threw — ${message}`);
      return { ok: false, error: message };
    }
  }

  /** Legacy boolean form of `request` for the send paths. */
  private async dispatchAction(action: string, payload: Record<string, unknown>): Promise<boolean> {
    return (await this.request(action, payload)).ok;
  }

  private toAction(res: RequestResult): ActionResult {
    if (res.ok) return { ok: true };
    return { ok: false, error: res.error, ...(res.code !== undefined ? { code: res.code } : {}) };
  }

  private readErrorMessage(msg: MtwMessage): string {
    return this.readError(msg).message;
  }

  /**
   * mtwRequest errors are `MtwMessage::error(code, message)`, on the wire
   * `{ kind: "Json", data: { code, message } }`. The older `{ json: {...} }`
   * shape is still read.
   */
  private readError(msg: MtwMessage): { message: string; code?: string } {
    const payload = msg.payload as unknown;
    if (payload && typeof payload === "object") {
      const p = payload as { data?: unknown; json?: unknown };
      for (const body of [p.data, p.json]) {
        if (body && typeof body === "object" && "message" in body) {
          const b = body as { message: unknown; code?: unknown };
          const message = String(b.message);
          let code = b.code !== undefined && b.code !== null ? String(b.code) : undefined;
          // mtw-server sends an HTTP-ish number plus `"<token>: …"`; the token
          // is the code callers branch on (`invalid_phone`, `not_connected`…).
          if (code === undefined || /^\d+$/.test(code)) {
            const m = /^([a-z_]+):/.exec(message);
            if (m) code = m[1];
          }
          return { message, ...(code !== undefined ? { code } : {}) };
        }
      }
    }
    return { message: "unknown error" };
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
    // Never log the QR string itself.
    log.info("WhatsApp: QR code received — scan from the dashboard.");
  }

  private handlePairing(msg: MtwMessage): void {
    const data = this.extractJson<PairingPayload>(msg);
    if (!data?.code) return;
    this.pairingCode = data.code;
    this.pairingExpiresAt = typeof data.expires_at === "number" ? data.expires_at : null;
    // Never log the pairing code itself.
    log.info("WhatsApp: pairing code received — enter it on the phone.");
  }

  private handleStatus(msg: MtwMessage): void {
    const data = this.extractJson<StatusPayload>(msg);
    if (!data || typeof data.state !== "string") return;

    switch (data.state) {
      case "idle":
      case "linking":
      case "connected":
      case "disconnected":
      case "logged_out":
      case "unknown":
        this.linkState = data.state;
        this.linkMode = data.mode ?? null;
        this.linkReason = data.reason ?? null;
        break;
      default:
        break;
    }

    switch (data.state) {
      case "connected":
        this.connectedJid = data.jid ?? null;
        this.connectedLid = typeof data.lid === "string" && data.lid ? data.lid : null;
        this.currentQr = null;
        this.pairingCode = null;
        this.pairingExpiresAt = null;
        this.lastError = undefined;
        // The JID carries the phone number — not logged.
        log.info("WhatsApp: connected");
        void this.autoConfigure();
        break;
      case "linking":
        this.connectedLid = null;
        log.info(`WhatsApp: linking${data.mode ? ` (${data.mode})` : ""}`);
        break;
      case "paired":
        log.info("WhatsApp: device paired");
        break;
      case "unknown":
        // Bridge dropped (mtw-server lost the socket): nothing is linked now.
        this.connectedJid = null;
        this.connectedLid = null;
        break;
      case "disconnected":
        this.connectedJid = null;
        this.connectedLid = null;
        log.warn(`WhatsApp: disconnected — ${data.reason ?? ""}`);
        break;
      case "idle":
      case "logged_out":
        this.connectedJid = null;
        this.connectedLid = null;
        this.currentQr = null;
        this.pairingCode = null;
        this.pairingExpiresAt = null;
        log.info(`WhatsApp: ${data.state}`);
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

  /**
   * First link: a channel with no `defaultChat` / `allowedNumbers` gets the
   * linked number for both, so notifications and replies work without a
   * trip to settings. The persister has the last word: it fills only what is
   * empty in the stored config and hands back that config, which replaces
   * the in-memory one (memory can be stale if Settings saved meanwhile).
   */
  private async autoConfigure(): Promise<void> {
    if (!this.connectedJid) return;
    const number = jidNumber(this.connectedJid);
    if (!number) return;
    const empty = (v: unknown) => typeof v !== "string" || v.trim() === "";
    const patch: Record<string, unknown> = {};
    if (empty(this.config.defaultChat)) patch.defaultChat = `${number}@s.whatsapp.net`;
    if (empty(this.config.allowedNumbers)) patch.allowedNumbers = number;
    if (Object.keys(patch).length === 0) return;
    if (!this.persistConfig) {
      this.config = { ...this.config, ...patch };
      return;
    }
    try {
      const stored = await this.persistConfig(patch);
      if (stored && typeof stored === "object") {
        const filled = Object.keys(patch).filter((k) => stored[k] === patch[k]);
        this.config = { ...this.config, ...stored };
        if (filled.length > 0) log.info(`WhatsApp: auto-configured ${filled.join(", ")}`);
      } else {
        this.config = { ...this.config, ...patch };
        log.info(`WhatsApp: auto-configured ${Object.keys(patch).join(", ")}`);
      }
    } catch (err) {
      log.warn(`WhatsApp: saving auto-config failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleInbound(msg: MtwMessage): Promise<void> {
    const data = this.extractJson<InboundPayload>(msg);
    if (!data) return;

    // Messages the linked account writes itself are only taken from its own
    // chat ("message yourself"); anything typed to a contact must never reach
    // the office, or it would answer into that contact's chat.
    // Own chat and own authorship match the own number or, when the bridge
    // sent it, the own LID (the self-chat can be addressed as `<lid>@lid`).
    const own = this.connectedJid ? jidNumber(this.connectedJid) : null;
    const lid = this.connectedLid;
    const ownChat = (own !== null && jidNumber(data.chat) === own) || sameLid(data.chat, lid);
    // `author` and `sender_alt` are the same sender under its two addresses
    // (phone JID and LID, in either order); check both.
    const alt = typeof data.sender_alt === "string" && data.sender_alt ? data.sender_alt : null;
    const addresses = [data.author, alt].filter((j): j is string => typeof j === "string" && j !== "");
    const authorIsOwn = addresses.some(
      (j) => (own !== null && isPhoneJid(j) && jidNumber(j) === own) || sameLid(j, lid),
    );
    const fromMe = data.from_me === true || authorIsOwn;
    if (fromMe && !ownChat) return;

    // The allowlist holds phone numbers: match on whichever address is a
    // phone JID; with none, only `*` or a chat entry can let it through. A
    // message from the own account (by LID or from_me) is matched as the own
    // number.
    const phoneJid = addresses.find(isPhoneJid) ?? null;
    const sender = fromMe && own !== null ? `${own}@s.whatsapp.net` : phoneJid;
    if (!this.isAllowed(sender, data.chat)) {
      log.warn("WhatsApp: dropped inbound from unauthorized sender");
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

  private isAllowed(sender: string | null, chat?: string): boolean {
    const list = csvList(this.config.allowedNumbers);
    if (list.length === 0) return false;
    if (list.includes("*")) return true;
    // Entries with "@" are chat JIDs (a group like `123456@g.us`): every
    // message in that chat passes, whoever wrote it.
    if (chat && list.some((n) => n.includes("@") && n === chat)) return true;
    // Exact digit-match only. The previous bidirectional `includes` let any
    // number that was a substring of (or superstring containing) an allowlisted
    // number pass the gate — a full auth bypass, since the allowlist is the SOLE
    // trust gate for WhatsApp (no pairing flow). Normalize away +/space/dashes.
    if (!sender) return false;
    const phone = sender.split("@")[0].split(":")[0].replace(/\D/g, "");
    if (!phone) return false;
    return list.some((n) => !n.endsWith("@g.us") && n.replace(/\D/g, "") === phone);
  }

  private formatPayload(payload: NotificationPayload): string {
    return formatNotification(payload, { bold: "*", alert: "🚨 " });
  }
}

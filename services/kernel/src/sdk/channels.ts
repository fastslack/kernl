/**
 * Pieces every channel extension wrote for itself: the notification text,
 * the comma-list config fields, the MIME → attachment kind mapping, splitting
 * a reply to the platform's message limit, and — for providers that wrap a
 * ChannelTransport — the provider itself.
 */

import type {
  ChannelAttachment,
  ChannelTransport,
  ConfigField,
  NotificationPayload,
  NotificationProvider,
  ProviderCapability,
  ProviderStatus,
} from "./types.js";
import { log } from "./log.js";

// ── Text ────────────────────────────────────────────────────────

export interface NotificationStyle {
  /** Bold marker of the platform's markdown: `**` (Discord, Mattermost) or `*` (Slack, Telegram, WhatsApp). */
  bold: string;
  /** Prefix for a high-priority notification. */
  alert: string;
}

/** "<alert><bold>title<bold>\nbody" — the one notification layout every channel used. */
export function formatNotification(payload: NotificationPayload, style: NotificationStyle): string {
  const prefix = payload.priority === "high" ? style.alert : "";
  const lines = [`${prefix}${style.bold}${payload.title}${style.bold}`];
  if (payload.body) lines.push(payload.body);
  return lines.join("\n");
}

/** A comma-separated config field as a list: trimmed, empties dropped, `[]` when not a string. */
export function csvList(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

export function mimeToAttachmentType(mimeType: string): ChannelAttachment["type"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

const FENCE = "```";

/**
 * Split `text` into pieces of at most `limit` characters, for platforms that
 * reject a longer message outright (Discord 2000, Telegram 4096) — an agent's
 * reply is often longer, and without this it was lost whole.
 *
 * Cuts at the last paragraph break, else line break, else space before the
 * limit, and only mid-word when a single word is longer than the limit. A
 * cut inside a ``` block closes the fence on one side and reopens it on the
 * next, so both halves still render as code.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  let reopen = "";
  while (rest.length > 0) {
    // Room for a reopened fence at the start and a closing one at the end.
    const budget = limit - reopen.length - (FENCE.length + 1);
    let piece: string;
    if (reopen.length + rest.length <= limit) {
      piece = rest;
      rest = "";
    } else {
      const window = rest.slice(0, budget);
      // The latest break of the strongest kind that still keeps the piece at
      // least half full, so a stray early break does not leave a stub.
      const half = Math.floor(budget / 2);
      const cut = ["\n\n", "\n", " "]
        .map((sep) => window.lastIndexOf(sep))
        .find((i) => i >= half) ?? budget;
      piece = rest.slice(0, cut);
      rest = rest.slice(cut).replace(/^\s+/, "");
    }
    let chunk = reopen + piece;
    const open = (chunk.split(FENCE).length - 1) % 2 === 1;
    if (open && rest.length > 0) {
      chunk += `\n${FENCE}`;
      reopen = `${FENCE}\n`;
    } else {
      reopen = "";
    }
    chunks.push(chunk);
  }
  return chunks;
}

// ── Provider over a ChannelTransport ────────────────────────────

/**
 * A NotificationProvider that is a thin shell around a ChannelTransport:
 * start builds and starts the transport, notifications go through
 * `sendToDefault`/`send`, status reflects the transport. A subclass supplies
 * its identity, its config form and how to build its transport.
 */
export abstract class TransportNotificationProvider<T extends ChannelTransport = ChannelTransport>
implements NotificationProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly icon: string;
  abstract readonly capabilities: ProviderCapability[];
  protected abstract readonly style: NotificationStyle;
  /** Config keys that must be non-empty strings to save and to start. */
  protected abstract readonly requiredKeys: string[];

  protected transport: T | null = null;
  protected config: Record<string, unknown> = {};
  protected ready = false;
  protected error: string | undefined;

  abstract getConfigSchema(): ConfigField[];
  protected abstract createTransport(config: Record<string, unknown>): Promise<T>;

  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors = this.requiredKeys
      .filter((key) => !config[key] || typeof config[key] !== "string")
      .map((key) => `${key} is required`);
    return errors.length ? { valid: false, errors } : { valid: true };
  }

  configure(config: Record<string, unknown>): void {
    this.config = config;
  }

  async start(): Promise<void> {
    try {
      this.transport = await this.createTransport(this.config);
      await this.transport.start();
      this.ready = this.transport.isReady();
      this.error = undefined;
    } catch (err) {
      this.error = String(err);
      this.ready = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.transport) {
      await this.transport.stop();
      this.transport = null;
    }
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready && this.transport !== null && this.transport.isReady();
  }

  /** Whether the saved config is enough to run: every required key present. */
  protected isEnabled(): boolean {
    return this.requiredKeys.every((key) => !!this.config[key]);
  }

  getStatus(): ProviderStatus {
    return {
      id: this.id,
      name: this.name,
      icon: this.icon,
      connected: this.isReady(),
      enabled: this.isEnabled(),
      error: this.error,
      capabilities: this.capabilities,
    };
  }

  async sendNotification(payload: NotificationPayload): Promise<boolean> {
    if (!this.isReady() || !this.transport?.sendToDefault) return false;
    try {
      await this.transport.sendToDefault({ text: formatNotification(payload, this.style) });
      return true;
    } catch (err) {
      log.error(`${this.name} notification failed`, err);
      return false;
    }
  }

  async sendTo(target: string, payload: NotificationPayload): Promise<boolean> {
    if (!this.isReady() || !this.transport) return false;
    try {
      await this.transport.send(target, { text: formatNotification(payload, this.style) });
      return true;
    } catch (err) {
      log.error(`${this.name} send to ${target} failed`, err);
      return false;
    }
  }

  async sendTest(): Promise<boolean> {
    return this.sendNotification({
      title: `Kernl — ${this.name} test`,
      body: `${this.name} notification channel working!`,
    });
  }

  getTransport(): T | null {
    return this.transport;
  }
}

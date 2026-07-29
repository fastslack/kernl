/**
 * Channel bridge — bidirectional mirror between IRC channels and the kernel's
 * other messaging channels (telegram/slack/discord/webchat).
 *
 *  - Outbound (IRC → external): when a real user posts in a bridged IRC
 *    channel, forward the text to the mapped external provider via the
 *    NotificationRegistry's `sendTo`.
 *  - Inbound (external → IRC): `injectFromExternal()` posts an external message
 *    into the mapped IRC channel as a synthetic user. Call it from wherever the
 *    kernel surfaces inbound channel messages (a tool, an event subscription).
 *
 * Mappings live in the kernel config store so they survive restarts.
 */
import { log } from "../../../../../../src/core/logger.js";
import type { IrcServer } from "../server/ircd.js";

/** Minimal slice of NotificationRegistry the bridge calls. */
export interface RegistryLike {
  sendTo(
    providerId: string,
    target: string,
    payload: { title: string; body: string },
  ): Promise<boolean>;
}

export interface BridgeMapping {
  ircChannel: string; // "#tg-12345"
  provider: string; // "telegram" | "slack" | "discord" | "webchat"
  target: string; // external chat/channel id
}

export class ChannelBridge {
  private byIrc = new Map<string, BridgeMapping>();
  private byExternal = new Map<string, BridgeMapping>(); // `${provider}:${target}`

  constructor(
    private server: IrcServer,
    private registry: RegistryLike,
  ) {}

  addMapping(m: BridgeMapping): void {
    const irc = m.ircChannel.startsWith("#") ? m.ircChannel : "#" + m.ircChannel;
    const mapping = { ...m, ircChannel: irc };
    this.byIrc.set(irc.toLowerCase(), mapping);
    this.byExternal.set(`${m.provider}:${m.target}`, mapping);
    this.server.ensureOfficeChannel(irc, ""); // create the channel (not an office)
    log.info(`IRC channel-bridge: ${irc} ↔ ${m.provider}:${m.target}`);
  }

  listMappings(): BridgeMapping[] {
    return [...this.byIrc.values()];
  }

  /** Outbound: a user posted in a bridged IRC channel → push to the external provider. */
  forwardToExternal(ircChannel: string, fromNick: string, text: string): void {
    const m = this.byIrc.get(ircChannel.toLowerCase());
    if (!m) return;
    void this.registry
      .sendTo(m.provider, m.target, { title: "", body: `<${fromNick}> ${text}` })
      .catch((err) => log.error(`IRC channel-bridge: forward to ${m.provider} failed`, err));
  }

  /** Inbound: an external message → post into the mapped IRC channel. */
  injectFromExternal(provider: string, target: string, sender: string, text: string): boolean {
    const m = this.byExternal.get(`${provider}:${target}`);
    if (!m) return false;
    const nick = `${provider}-${sender}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30) || provider;
    this.server.createAgentUser(nick, nick, `${provider} bridge`);
    this.server.postToChannel(nick, m.ircChannel, text);
    return true;
  }

  isBridged(ircChannel: string): boolean {
    return this.byIrc.has(ircChannel.toLowerCase());
  }
}

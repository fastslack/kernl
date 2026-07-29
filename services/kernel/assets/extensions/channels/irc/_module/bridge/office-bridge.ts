/**
 * Office bridge — maps kernel offices (agent flows) to IRC channels and agents
 * to IRC users. When a real user posts in an office channel, the office's
 * agents are run and their replies are posted back as their own IRC users.
 *
 * The bridge talks to the agents module through a small structural interface
 * (`OfficeAgentSource`) so this file never imports the agents module directly —
 * index.ts builds a concrete, duck-typed adapter (graceful if agents absent).
 */
import { log } from "../../../../../../src/core/logger.js";
import type { IrcServer, InboundEvent } from "../server/ircd.js";

export interface OfficeDescriptor {
  flowId: string;
  name: string;
  /** Channel-safe slug (no '#', lowercased). */
  slug: string;
  agents: { nick: string; account: string; realname?: string }[];
}

export interface OfficeReply {
  agentNick: string;
  text: string;
}

export interface OfficeAgentSource {
  /** List offices + their agents to seed channels/users. */
  listOffices(): OfficeDescriptor[];
  /** Run the office's agents for a user message; return per-agent replies. */
  runOffice(opts: {
    flowId: string;
    channel: string;
    text: string;
    fromNick: string;
  }): Promise<OfficeReply[]>;
}

export class OfficeBridge {
  private channelToFlow = new Map<string, string>(); // #channel → flowId

  constructor(
    private server: IrcServer,
    private source: OfficeAgentSource,
  ) {}

  /** Seed office channels + agent pseudo-users. Safe to call repeatedly. */
  sync(): void {
    let offices: OfficeDescriptor[] = [];
    try {
      offices = this.source.listOffices();
    } catch (err) {
      log.error("IRC office-bridge: listOffices failed", err);
      return;
    }
    for (const office of offices) {
      const channel = `#${office.slug}`;
      this.server.ensureOfficeChannel(channel, office.flowId);
      this.channelToFlow.set(channel.toLowerCase(), office.flowId);
      for (const agent of office.agents) {
        const u = this.server.createAgentUser(agent.nick, agent.account, agent.realname);
        // Join the agent to its office channel (silent — pseudo-client).
        this.server.ensureOfficeChannel(channel, office.flowId);
        this.joinAgent(u.nick, channel);
      }
    }
    log.info(`IRC office-bridge: synced ${offices.length} offices`);
  }

  private joinAgent(nick: string, channel: string): void {
    // Agents are joined by injecting a JOIN through the server's public path:
    // they have no socket, so we use postToChannel-less membership via a JOIN
    // command handled as a pseudo-client. Simplest: mark membership in store +
    // let ensureOfficeChannel keep the channel; presence shows via WHO/NAMES
    // once the agent posts. We post a one-time presence NOTICE.
    this.server.postToChannel(nick, channel, `${nick} is on duty.`, { kind: "NOTICE" });
  }

  /** Handle a user message posted in an office channel. */
  handle(ev: InboundEvent): void {
    if (ev.targetType !== "channel" || !ev.officeFlow) return;
    if (ev.encrypted) return; // can't run agents on ciphertext
    const flowId = ev.officeFlow;
    const channel = ev.target;
    const fromNick = ev.from.nick;

    void this.source
      .runOffice({ flowId, channel, text: ev.text, fromNick })
      .then((replies) => {
        for (const r of replies) {
          this.server.createAgentUser(r.agentNick, r.agentNick);
          this.server.postToChannel(r.agentNick, channel, r.text);
        }
      })
      .catch((err) => {
        log.error("IRC office-bridge: runOffice failed", err);
        this.server.postToChannel("kernel", channel, `⚠️ office run failed: ${err instanceof Error ? err.message : err}`, { kind: "NOTICE" });
      });
  }
}

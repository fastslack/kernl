/**
 * UpstreamManager — the bouncer. Owns one UpstreamConnection per configured
 * network and translates between them and the local server:
 *
 *   upstream PRIVMSG #argentina   ->  local #argentina/dalnet
 *   local PRIVMSG #argentina/dalnet -> upstream PRIVMSG #argentina
 *
 * Connections belong to an account, so a client only ever relays through, or
 * even sees, the networks its own account owns.
 */
import { log } from "../../../../../../src/core/logger.js";
import { newId } from "../../../../../../src/core/helpers.js";
import type { IrcServer, InboundEvent } from "../server/ircd.js";
import type { IrcClient } from "../server/client.js";
import type { IrcStore } from "../store.js";
import type { IrcMessage } from "../server/parser.js";
import { ERR } from "../server/numerics.js";
import { UpstreamStore, type UpstreamRow } from "./store.js";
import {
  UpstreamConnection,
  createRealSocketFactory,
  type SocketFactory,
  type UpstreamState,
} from "./connection.js";
import { parseLocalTarget, toLocalTarget, toLocalNick, isChannelName } from "./naming.js";

export interface UpstreamStatus {
  id: string;
  account: string;
  network: string;
  label: string;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  currentNick: string;
  saslAccount: string;
  hasPassword: boolean;
  enabled: boolean;
  state: UpstreamState;
  lastError: string;
  channels: string[];
}

/**
 * Who owns an upstream from this session's point of view: the SASL account
 * when the server authenticates, the nick when it does not. Without the nick
 * fallback a kernel with no SASL password configured could never own a
 * network, which made the whole bouncer unusable on a single-owner install.
 */
function ownerOf(client: IrcClient): string {
  return client.account || client.nick;
}

export interface ManagerDeps {
  server: IrcServer;
  store: UpstreamStore;
  ircStore: IrcStore;
  serverName: string;
  socketFactory?: SocketFactory;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
}

export class UpstreamManager {
  private conns = new Map<string, UpstreamConnection>();
  private socketFactory: SocketFactory;

  constructor(private deps: ManagerDeps) {
    this.socketFactory = deps.socketFactory ?? createRealSocketFactory();
  }

  // ── Lifecycle ───────────────────────────────────────────────

  /** Connect every enabled network. Safe to call twice. */
  start(): void {
    for (const row of this.deps.store.listEnabled()) this.connect(row.id);
  }

  stop(): void {
    for (const conn of this.conns.values()) conn.stop("Kernel shutting down");
    this.conns.clear();
  }

  connect(id: string): boolean {
    const row = this.deps.store.get(id);
    if (!row) return false;
    this.conns.get(id)?.stop("Reconnecting");
    const conn = new UpstreamConnection(
      {
        id: row.id,
        network: row.network,
        host: row.host,
        port: row.port,
        tls: row.tls === 1,
        nick: row.nick,
        username: row.username,
        realname: row.realname,
        saslAccount: row.sasl_account,
        password: this.deps.store.password(row),
      },
      {
        socketFactory: this.socketFactory,
        setTimer: this.deps.setTimer,
        clearTimer: this.deps.clearTimer,
        random: this.deps.random,
      },
    );
    conn.onMessage = (msg) => this.onUpstreamMessage(row, conn, msg);
    conn.onState = (state, error) => this.onConnState(row, state, error);
    conn.onRegistered = () => this.rejoinChannels(row, conn);
    this.conns.set(id, conn);
    conn.start();
    return true;
  }

  disconnect(id: string): boolean {
    const conn = this.conns.get(id);
    if (!conn) return false;
    conn.stop();
    this.conns.delete(id);
    return true;
  }

  /** Apply a config change: reconnect if it was running. */
  reload(id: string): void {
    const wasRunning = this.conns.has(id);
    this.disconnect(id);
    const row = this.deps.store.get(id);
    if (row && row.enabled === 1 && wasRunning) this.connect(id);
  }

  status(account?: string): UpstreamStatus[] {
    return this.deps.store.list(account).map((row) => {
      const conn = this.conns.get(row.id);
      return {
        id: row.id,
        account: row.account,
        network: row.network,
        label: row.label,
        host: row.host,
        port: row.port,
        tls: row.tls === 1,
        nick: row.nick,
        currentNick: conn?.currentNick ?? row.nick,
        saslAccount: row.sasl_account,
        hasPassword: this.deps.store.hasPassword(row),
        enabled: row.enabled === 1,
        state: conn?.state ?? "idle",
        lastError: conn?.lastError || row.last_error,
        channels: this.deps.store.channels(row.id).map((c) => c.channel),
      };
    });
  }

  // ── Local -> upstream ───────────────────────────────────────

  /**
   * Outbound hook for IrcServer.onMessage. Returns true when the message was
   * relayed, so the caller knows not to treat it as a native message.
   */
  handleOutbound(ev: InboundEvent): boolean {
    const parsed = parseLocalTarget(ev.target);
    if (!parsed) return false;
    const row = this.rowFor(ownerOf(ev.from), parsed.network);
    if (!row) return false;
    const conn = this.conns.get(row.id);
    if (!conn || !conn.isConnected()) {
      this.notify(ev.from, `${parsed.network} is not connected — message not sent`);
      return true;
    }
    conn.privmsg(parsed.target, ev.text);
    return true;
  }

  /**
   * JOIN veto. A network-suffixed channel is only joinable by the account that
   * owns that network, and triggers the upstream JOIN.
   */
  handleBeforeJoin(client: IrcClient, channel: string): boolean {
    const parsed = parseLocalTarget(channel);
    if (!parsed) return true; // native channel, not ours
    const row = this.rowFor(ownerOf(client), parsed.network);
    if (!row) {
      client.numeric(
        this.deps.serverName,
        ERR.NOSUCHCHANNEL,
        channel,
        `No upstream network "${parsed.network}" configured for this account`,
      );
      return false;
    }
    this.deps.store.addChannel(row.id, parsed.target);
    const conn = this.conns.get(row.id);
    if (conn?.isConnected()) conn.join(parsed.target);
    return true;
  }

  /** PART observer: leave the upstream channel and stop rejoining it. */
  handlePart(client: IrcClient, channel: string): void {
    const parsed = parseLocalTarget(channel);
    if (!parsed) return;
    const row = this.rowFor(ownerOf(client), parsed.network);
    if (!row) return;
    this.deps.store.removeChannel(row.id, parsed.target);
    this.conns.get(row.id)?.part(parsed.target);
  }

  // ── Upstream -> local ───────────────────────────────────────

  private onUpstreamMessage(row: UpstreamRow, conn: UpstreamConnection, msg: IrcMessage): void {
    const cmd = msg.command.toUpperCase();
    // The parser keeps the raw prefix; the nick is everything before '!'.
    const from = (msg.prefix ?? "").split("!")[0] || row.network;
    switch (cmd) {
      case "PRIVMSG":
      case "NOTICE": {
        const target = msg.params[0] ?? "";
        const text = msg.params[1] ?? "";
        if (!target || !text) return;
        const kind = cmd === "NOTICE" ? "NOTICE" : "PRIVMSG";
        if (isChannelName(target)) {
          const local = toLocalTarget(row.network, target);
          this.deps.server.ensureChannel(local);
          const nick = toLocalNick(row.network, from);
          this.deps.server.addRelayMember(nick, local);
          this.deps.server.postToChannel(nick, local, text, { kind });
        } else {
          // A private message: the buffer is named after the sender.
          this.deliverQuery(row, from, text, kind);
        }
        return;
      }
      case "JOIN": {
        const chan = msg.params[0] ?? "";
        if (!chan || from === conn.currentNick) return;
        const local = toLocalTarget(row.network, chan);
        this.deps.server.ensureChannel(local);
        this.deps.server.addRelayMember(toLocalNick(row.network, from), local);
        return;
      }
      case "PART": {
        const chan = msg.params[0] ?? "";
        if (!chan) return;
        this.deps.server.removeRelayMember(
          toLocalNick(row.network, from),
          toLocalTarget(row.network, chan),
        );
        return;
      }
      case "QUIT":
        this.deps.server.removeRelayUser(toLocalNick(row.network, from));
        return;
      case "NICK": {
        const to = msg.params[0] ?? "";
        if (!to) return;
        this.deps.server.removeRelayUser(toLocalNick(row.network, from));
        this.deps.server.ensureRelayUser(toLocalNick(row.network, to));
        return;
      }
      case "332": {
        // RPL_TOPIC — surface it in the mirrored channel.
        const chan = msg.params[1] ?? "";
        const topic = msg.params[2] ?? "";
        if (!chan) return;
        const local = toLocalTarget(row.network, chan);
        this.deps.server.ensureChannel(local);
        this.deps.server.postToChannel(row.network, local, `Topic: ${topic}`, { kind: "NOTICE" });
        return;
      }
      case "353": {
        // RPL_NAMREPLY — populate the mirrored member list.
        const chan = msg.params[2] ?? "";
        const names = (msg.params[3] ?? "").split(" ").filter(Boolean);
        if (!chan) return;
        const local = toLocalTarget(row.network, chan);
        this.deps.server.ensureChannel(local);
        for (const raw of names) {
          const prefix = /^[~&@%+]/.test(raw) ? raw[0] : "";
          const nick = prefix ? raw.slice(1) : raw;
          if (nick === conn.currentNick) continue;
          this.deps.server.addRelayMember(toLocalNick(row.network, nick), local, prefix);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Relay a private message into every session of the owning account. */
  private deliverQuery(row: UpstreamRow, from: string, text: string, kind: "PRIVMSG" | "NOTICE"): void {
    const buffer = toLocalTarget(row.network, from);
    const nick = toLocalNick(row.network, from);
    this.deps.server.ensureRelayUser(nick);
    const sessions = this.deps.server.clientsForOwner(row.account);
    for (const client of sessions) {
      client.send(
        { prefix: `${nick}!upstream@${row.network}`, command: kind, params: [client.nick, text] },
        { msgid: newId() },
      );
    }
    if (kind === "PRIVMSG") {
      // Stored under the buffer name so CHATHISTORY works for queries too.
      this.deps.ircStore.storeMessage({
        msgid: newId(),
        target: buffer,
        sender: nick,
        account: row.account,
        payload: text,
      });
    }
  }

  private onConnState(row: UpstreamRow, state: UpstreamState, error: string): void {
    if (error) {
      this.deps.store.setError(row.id, error);
      log.warn(`IRC upstream ${row.network}: ${state} — ${error}`);
    } else if (state === "connected") {
      this.deps.store.setError(row.id, "");
      log.info(`IRC upstream ${row.network}: connected as ${row.nick}`);
    }
    for (const client of this.deps.server.clientsForOwner(row.account)) {
      client.send({
        prefix: this.deps.serverName,
        command: "NOTICE",
        params: [client.nick, `[${row.network}] ${state}${error ? `: ${error}` : ""}`],
      });
    }
  }

  private rejoinChannels(row: UpstreamRow, conn: UpstreamConnection): void {
    for (const c of this.deps.store.channels(row.id)) conn.join(c.channel, c.key);
  }

  private rowFor(account: string, network: string): UpstreamRow | undefined {
    if (!account) return undefined;
    return this.deps.store.find(account, network);
  }

  private notify(client: IrcClient, text: string): void {
    client.send({
      prefix: this.deps.serverName,
      command: "NOTICE",
      params: [client.nick, text],
    });
  }
}

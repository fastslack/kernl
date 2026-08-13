/**
 * IrcServer — the protocol state machine. Transport-agnostic: the transport
 * builds an `IrcClient` per connection, calls `attach()`, then forwards parsed
 * messages to `handle()` and disconnects via `disconnect()`.
 *
 * Implements classic RFC 1459/2812 commands plus IRCv3 (CAP, SASL,
 * message-tags, server-time, echo-message, account-tag, away-notify,
 * multi-prefix, CHATHISTORY) and the +E (E2E) channel mode whose payloads the
 * server stores/relays as ciphertext.
 */
import { newId, isoNow } from "../../../../../../src/core/helpers.js";
import { log } from "../../../../../../src/core/logger.js";
import type { IrcStore } from "../store.js";
import { SaslAuthenticator, decodePlain } from "../security/sasl.js";
import { IrcClient } from "./client.js";
import { RPL, ERR } from "./numerics.js";
import type { IrcMessage } from "./parser.js";

export interface IrcServerConfig {
  serverName: string;
  networkName: string;
  motd: string;
  historyLimit: number;
  requireSasl: boolean;
  requireClientCert: boolean;
}

export interface InboundEvent {
  from: IrcClient;
  targetType: "channel" | "nick";
  target: string;
  text: string;
  /** True if the target channel is mapped to a kernel office. */
  channelIsOffice: boolean;
  officeFlow?: string;
  encrypted: boolean;
}

interface Channel {
  name: string;
  members: Map<string, { client: IrcClient; prefix: string }>; // by client.id
  topic: string;
  topicBy: string;
  topicAt: string;
  e2e: boolean;
  noExternal: boolean; // +n
  isOffice: boolean;
  officeFlow?: string;
}

const SUPPORTED_CAPS = [
  "message-tags",
  "server-time",
  "echo-message",
  "account-tag",
  "account-notify",
  "away-notify",
  "multi-prefix",
  "chghost",
  "batch",
  "labeled-response",
  "sasl",
  "draft/chathistory",
];

export class IrcServer {
  private clients = new Map<string, IrcClient>();
  private nicks = new Map<string, IrcClient>(); // lower(nick) → client
  private channels = new Map<string, Channel>(); // lower(name) → channel
  readonly createdAt = isoNow();

  /** Set by the bridge layer to route user→channel/nick messages into the kernel. */
  onMessage: ((ev: InboundEvent) => void) | null = null;

  /**
   * Veto/observe hook for JOIN, set by the upstream relay. Returning false
   * aborts the join; the hook owns telling the client why.
   */
  onBeforeJoin: ((client: IrcClient, channel: string) => boolean) | null = null;

  /** Observed after a client parts a channel, so the relay can PART upstream. */
  onPart: ((client: IrcClient, channel: string) => void) | null = null;

  constructor(
    private cfg: IrcServerConfig,
    private store: IrcStore,
    private sasl: SaslAuthenticator,
  ) {}

  // ── lifecycle ───────────────────────────────────────────────
  attach(client: IrcClient): void {
    this.clients.set(client.id, client);
  }

  disconnect(client: IrcClient, reason = "Connection closed"): void {
    for (const chan of this.channels.values()) {
      if (chan.members.delete(client.id)) {
        this.broadcastToChannel(
          chan,
          { prefix: client.mask(), command: "QUIT", params: [reason] },
          client.id,
        );
      }
    }
    if (client.nick !== "*") this.nicks.delete(client.nick.toLowerCase());
    this.clients.delete(client.id);
  }

  // ── command dispatch ────────────────────────────────────────
  handle(client: IrcClient, msg: IrcMessage): void {
    try {
      const fn = (this as unknown as Record<string, (c: IrcClient, m: IrcMessage) => void>)[
        `cmd_${msg.command}`
      ];
      if (typeof fn === "function") {
        fn.call(this, client, msg);
      } else if (client.registered) {
        client.numeric(this.cfg.serverName, ERR.UNKNOWNCOMMAND, msg.command, "Unknown command");
      }
    } catch (err) {
      log.error(`IRC: error handling ${msg.command}`, err);
    }
  }

  // ── registration ────────────────────────────────────────────
  private cmd_CAP(client: IrcClient, msg: IrcMessage): void {
    const sub = (msg.params[0] ?? "").toUpperCase();
    if (sub === "LS") {
      client.capNegotiating = true;
      client.send({
        prefix: this.cfg.serverName,
        command: "CAP",
        params: [client.nick, "LS", SUPPORTED_CAPS.join(" ")],
      });
    } else if (sub === "REQ") {
      const requested = (msg.params[1] ?? "").split(" ").filter(Boolean);
      const acked: string[] = [];
      for (const cap of requested) {
        const bare = cap.replace(/^-/, "");
        if (SUPPORTED_CAPS.includes(bare)) {
          if (cap.startsWith("-")) client.caps.delete(bare);
          else client.caps.add(bare);
          acked.push(cap);
        }
      }
      client.send({
        prefix: this.cfg.serverName,
        command: "CAP",
        params: [client.nick, "ACK", acked.join(" ")],
      });
    } else if (sub === "LIST") {
      client.send({
        prefix: this.cfg.serverName,
        command: "CAP",
        params: [client.nick, "LIST", [...client.caps].join(" ")],
      });
    } else if (sub === "END") {
      client.capNegotiating = false;
      this.tryRegister(client);
    }
  }

  private cmd_NICK(client: IrcClient, msg: IrcMessage): void {
    const wanted = msg.params[0];
    if (!wanted) {
      client.numeric(this.cfg.serverName, ERR.NONICKNAMEGIVEN, "No nickname given");
      return;
    }
    if (!/^[A-Za-z[\]\\`_^{}|][A-Za-z0-9[\]\\`_^{}|-]*$/.test(wanted) || wanted.length > 32) {
      client.numeric(this.cfg.serverName, ERR.ERRONEUSNICKNAME, wanted, "Erroneous nickname");
      return;
    }
    const key = wanted.toLowerCase();
    const holder = this.nicks.get(key);
    if (holder && holder.id !== client.id) {
      client.numeric(this.cfg.serverName, ERR.NICKNAMEINUSE, wanted, "Nickname is already in use");
      return;
    }
    const old = client.nick;
    if (client.nick !== "*") this.nicks.delete(client.nick.toLowerCase());
    client.nick = wanted;
    client.gotNick = true;
    this.nicks.set(key, client);

    if (client.registered) {
      // Notify the renamer + everyone sharing a channel.
      const announce = { prefix: `${old}!${client.user}@${client.host}`, command: "NICK", params: [wanted] };
      const seen = new Set<string>([client.id]);
      client.send(announce);
      for (const chan of this.channels.values()) {
        if (!chan.members.has(client.id)) continue;
        for (const m of chan.members.values()) {
          if (seen.has(m.client.id)) continue;
          seen.add(m.client.id);
          m.client.send(announce);
        }
      }
    } else {
      this.tryRegister(client);
    }
  }

  private cmd_USER(client: IrcClient, msg: IrcMessage): void {
    if (client.registered) {
      client.numeric(this.cfg.serverName, ERR.ALREADYREGISTERED, "You may not reregister");
      return;
    }
    if (msg.params.length < 4) {
      client.numeric(this.cfg.serverName, ERR.NEEDMOREPARAMS, "USER", "Not enough parameters");
      return;
    }
    client.user = msg.params[0];
    client.realname = msg.params[3];
    client.gotUser = true;
    this.tryRegister(client);
  }

  private cmd_PASS(): void {
    /* PASS accepted but unused — auth is SASL. */
  }

  private tryRegister(client: IrcClient): void {
    if (client.registered || client.capNegotiating) return;
    if (!client.gotNick || !client.gotUser) return;

    if (this.cfg.requireSasl && !client.account) {
      client.numeric(this.cfg.serverName, ERR.SASLFAIL, "You must authenticate (SASL) to use this server");
      return;
    }
    if (this.cfg.requireClientCert && !client.certFingerprint) {
      client.numeric(this.cfg.serverName, ERR.SASLFAIL, "A client certificate is required");
      return;
    }

    client.registered = true;
    if (client.account) this.store.upsertAccount({ account: client.account, nick: client.nick });

    const sn = this.cfg.serverName;
    client.numeric(sn, RPL.WELCOME, `Welcome to the ${this.cfg.networkName} IRC Network ${client.mask()}`);
    client.numeric(sn, RPL.YOURHOST, `Your host is ${sn}, running Kernl-ircd`);
    client.numeric(sn, RPL.CREATED, `This server was created ${this.createdAt}`);
    client.numeric(sn, RPL.MYINFO, sn, "Kernl-ircd", "ioswx", "obntmilkE");
    for (const tok of this.isupportTokens()) {
      client.numeric(sn, RPL.ISUPPORT, ...tok, "are supported by this server");
    }
    client.numeric(sn, RPL.LUSERCLIENT, `There are ${this.realClientCount()} users on 1 server`);
    this.sendMotd(client);

    if (client.account) {
      client.send({
        prefix: sn,
        command: RPL.LOGGEDIN,
        params: [client.nick, client.mask(), client.account, `You are now logged in as ${client.account}`],
      });
    }

    // Bouncer: rejoin persisted channels for this account.
    if (client.account) {
      for (const chanName of this.store.channelsFor(client.account)) {
        this.doJoin(client, chanName, { silent: false });
      }
    }
  }

  private isupportTokens(): string[][] {
    return [
      [`NETWORK=${this.cfg.networkName}`, "CHANTYPES=#", "CASEMAPPING=rfc1459"],
      ["PREFIX=(ov)@+", "CHANMODES=b,k,l,ntE", `CHATHISTORY=${this.cfg.historyLimit}`, "NICKLEN=32"],
    ];
  }

  private sendMotd(client: IrcClient): void {
    const sn = this.cfg.serverName;
    client.numeric(sn, RPL.MOTDSTART, `- ${sn} Message of the Day -`);
    for (const line of (this.cfg.motd || `Welcome to ${this.cfg.networkName}.`).split("\n")) {
      client.numeric(sn, RPL.MOTD, `- ${line}`);
    }
    client.numeric(sn, RPL.ENDOFMOTD, "End of /MOTD command");
  }

  // ── SASL ────────────────────────────────────────────────────
  private cmd_AUTHENTICATE(client: IrcClient, msg: IrcMessage): void {
    if (!client.hasCap("sasl")) return;
    const param = msg.params[0] ?? "";

    if (!client.saslMech) {
      const mech = param.toUpperCase();
      if (mech !== "PLAIN" && mech !== "EXTERNAL") {
        client.numeric(this.cfg.serverName, ERR.SASLFAIL, "SASL mechanism not supported");
        return;
      }
      if (mech === "EXTERNAL") {
        // EXTERNAL needs no client payload beyond the '+' continuation.
        client.saslMech = mech;
        client.send({ prefix: this.cfg.serverName, command: "AUTHENTICATE", params: ["+"] });
        return;
      }
      client.saslMech = mech;
      client.send({ prefix: this.cfg.serverName, command: "AUTHENTICATE", params: ["+"] });
      return;
    }

    // We have the mechanism; this is the response payload.
    void this.finishSasl(client, param);
  }

  private async finishSasl(client: IrcClient, payload: string): Promise<void> {
    const sn = this.cfg.serverName;
    const result =
      client.saslMech === "PLAIN"
        ? await this.sasl.authPlain(payload)
        : this.sasl.authExternal(client.certFingerprint, payload);

    client.saslMech = null;
    if (!result.ok || !result.account) {
      client.numeric(sn, ERR.SASLFAIL, result.error ?? "SASL authentication failed");
      return;
    }
    client.account = result.account;
    client.send({
      prefix: sn,
      command: RPL.LOGGEDIN,
      params: [client.nick, `${result.account}!*@*`, result.account, `You are now logged in as ${result.account}`],
    });
    client.numeric(sn, RPL.SASLSUCCESS, "SASL authentication successful");
  }

  // ── channels ────────────────────────────────────────────────
  private cmd_JOIN(client: IrcClient, msg: IrcMessage): void {
    if (!this.requireRegistered(client)) return;
    const names = (msg.params[0] ?? "").split(",").filter(Boolean);
    for (const name of names) this.doJoin(client, name);
  }

  private doJoin(client: IrcClient, name: string, opts: { silent?: boolean } = {}): void {
    if (!name.startsWith("#")) name = "#" + name;
    // The upstream relay vetoes joins to networks the client does not own, and
    // performs the upstream JOIN for the ones it does.
    if (this.onBeforeJoin && !this.onBeforeJoin(client, name)) return;
    const key = name.toLowerCase();
    let chan = this.channels.get(key);
    if (!chan) {
      const row = this.store.upsertChannel({ name });
      chan = {
        name,
        members: new Map(),
        topic: row.topic,
        topicBy: row.topic_by,
        topicAt: row.topic_at,
        e2e: row.e2e === 1,
        noExternal: true,
        isOffice: row.is_office === 1,
        officeFlow: row.office_flow || undefined,
      };
      this.channels.set(key, chan);
    }
    if (chan.members.has(client.id)) return;

    const isFirst = chan.members.size === 0;
    chan.members.set(client.id, { client, prefix: isFirst && !client.isAgent ? "@" : "" });
    if (client.account) this.store.addMembership(name, client.account, isFirst ? "@" : "");

    const joinMsg: Partial<IrcMessage> & { command: string } = {
      prefix: client.mask(),
      command: "JOIN",
      params: [name],
    };
    // account-tag aware JOIN
    this.broadcastToChannel(chan, joinMsg, undefined, client.account ?? undefined);

    if (!opts.silent) {
      this.sendChannelInfo(client, chan);
    }
  }

  private sendChannelInfo(client: IrcClient, chan: Channel): void {
    const sn = this.cfg.serverName;
    if (chan.topic) {
      client.numeric(sn, RPL.TOPIC, chan.name, chan.topic);
      client.numeric(sn, RPL.TOPICWHOTIME, chan.name, chan.topicBy || sn, String(Math.floor(Date.now() / 1000)));
    } else {
      client.numeric(sn, RPL.NOTOPIC, chan.name, "No topic is set");
    }
    if (chan.e2e) {
      client.send({ prefix: sn, command: "NOTICE", params: [chan.name, "This channel is end-to-end encrypted (+E)."] });
    }
    this.sendNames(client, chan);
  }

  private sendNames(client: IrcClient, chan: Channel): void {
    const multi = client.hasCap("multi-prefix");
    const names = [...chan.members.values()].map((m) => {
      const pfx = multi ? m.prefix : m.prefix.slice(0, 1);
      return pfx + m.client.nick;
    });
    client.numeric(this.cfg.serverName, RPL.NAMREPLY, "=", chan.name, names.join(" "));
    client.numeric(this.cfg.serverName, RPL.ENDOFNAMES, chan.name, "End of /NAMES list");
  }

  private cmd_PART(client: IrcClient, msg: IrcMessage): void {
    if (!this.requireRegistered(client)) return;
    const name = msg.params[0] ?? "";
    const reason = msg.params[1] ?? "";
    const chan = this.channels.get(name.toLowerCase());
    if (!chan || !chan.members.has(client.id)) {
      client.numeric(this.cfg.serverName, ERR.NOTONCHANNEL, name, "You're not on that channel");
      return;
    }
    this.broadcastToChannel(chan, { prefix: client.mask(), command: "PART", params: [chan.name, reason] });
    chan.members.delete(client.id);
    if (client.account) this.store.removeMembership(chan.name, client.account);
    this.onPart?.(client, chan.name);
  }

  private cmd_NAMES(client: IrcClient, msg: IrcMessage): void {
    if (!this.requireRegistered(client)) return;
    const chan = this.channels.get((msg.params[0] ?? "").toLowerCase());
    if (chan) this.sendNames(client, chan);
    else client.numeric(this.cfg.serverName, RPL.ENDOFNAMES, msg.params[0] ?? "*", "End of /NAMES list");
  }

  private cmd_TOPIC(client: IrcClient, msg: IrcMessage): void {
    if (!this.requireRegistered(client)) return;
    const name = msg.params[0] ?? "";
    const chan = this.channels.get(name.toLowerCase());
    if (!chan) {
      client.numeric(this.cfg.serverName, ERR.NOSUCHCHANNEL, name, "No such channel");
      return;
    }
    if (msg.params.length < 2) {
      if (chan.topic) client.numeric(this.cfg.serverName, RPL.TOPIC, chan.name, chan.topic);
      else client.numeric(this.cfg.serverName, RPL.NOTOPIC, chan.name, "No topic is set");
      return;
    }
    chan.topic = msg.params[1];
    chan.topicBy = client.nick;
    chan.topicAt = isoNow();
    this.store.setTopic(chan.name, chan.topic, client.nick);
    this.broadcastToChannel(chan, { prefix: client.mask(), command: "TOPIC", params: [chan.name, chan.topic] });
  }

  private cmd_LIST(client: IrcClient): void {
    if (!this.requireRegistered(client)) return;
    const sn = this.cfg.serverName;
    client.numeric(sn, RPL.LISTSTART, "Channel", "Users  Name");
    for (const chan of this.channels.values()) {
      client.numeric(sn, RPL.LIST, chan.name, String(chan.members.size), chan.topic);
    }
    client.numeric(sn, RPL.LISTEND, "End of /LIST");
  }

  // ── messaging ───────────────────────────────────────────────
  private cmd_PRIVMSG(client: IrcClient, msg: IrcMessage): void {
    this.deliverMessage(client, msg, "PRIVMSG");
  }
  private cmd_NOTICE(client: IrcClient, msg: IrcMessage): void {
    this.deliverMessage(client, msg, "NOTICE");
  }

  private deliverMessage(client: IrcClient, msg: IrcMessage, kind: "PRIVMSG" | "NOTICE"): void {
    if (!this.requireRegistered(client)) return;
    const target = msg.params[0];
    const text = msg.params[1] ?? "";
    if (!target) {
      client.numeric(this.cfg.serverName, ERR.NORECIPIENT, `No recipient given (${kind})`);
      return;
    }
    if (!text) {
      client.numeric(this.cfg.serverName, ERR.NOTEXTTOSEND, "No text to send");
      return;
    }
    const encrypted = msg.tags["+kernel.org/enc"] !== undefined || msg.tags["kernel.org/enc"] !== undefined;
    const msgid = newId();
    const extraTags: Record<string, string> = { msgid };
    if (client.account && client.hasCap("account-tag")) extraTags["account"] = client.account;
    if (encrypted) extraTags["+kernel.org/enc"] = "1";

    if (target.startsWith("#")) {
      const chan = this.channels.get(target.toLowerCase());
      if (!chan) {
        client.numeric(this.cfg.serverName, ERR.NOSUCHCHANNEL, target, "No such channel");
        return;
      }
      if (chan.noExternal && !chan.members.has(client.id)) {
        client.numeric(this.cfg.serverName, ERR.CANNOTSENDTOCHAN, target, "Cannot send to channel");
        return;
      }
      const out: Partial<IrcMessage> & { command: string } = {
        prefix: client.mask(),
        command: kind,
        params: [chan.name, text],
      };
      // Deliver to members (echo to sender only if echo-message negotiated).
      for (const m of chan.members.values()) {
        if (m.client.id === client.id && !client.hasCap("echo-message")) continue;
        m.client.send(out, extraTags);
      }
      if (kind === "PRIVMSG") {
        this.store.storeMessage({
          msgid,
          target: chan.name,
          sender: client.nick,
          account: client.account ?? "",
          payload: text,
          encrypted,
        });
        // Route into the kernel (agents / orchestrator / external bridges).
        this.onMessage?.({
          from: client,
          targetType: "channel",
          target: chan.name,
          text,
          channelIsOffice: chan.isOffice,
          officeFlow: chan.officeFlow,
          encrypted,
        });
      }
      return;
    }

    // Direct message to a nick.
    const dest = this.nicks.get(target.toLowerCase());
    if (!dest) {
      client.numeric(this.cfg.serverName, ERR.NOSUCHNICK, target, "No such nick/channel");
      return;
    }
    dest.send({ prefix: client.mask(), command: kind, params: [dest.nick, text] }, extraTags);
    if (dest.away && kind === "PRIVMSG") {
      client.numeric(this.cfg.serverName, RPL.AWAY, dest.nick, dest.away);
    }
    if (kind === "PRIVMSG") {
      this.store.storeMessage({
        msgid,
        target: dest.nick,
        sender: client.nick,
        account: client.account ?? "",
        payload: text,
        encrypted,
      });
      this.onMessage?.({
        from: client,
        targetType: "nick",
        target: dest.nick,
        text,
        channelIsOffice: false,
        encrypted,
      });
    }
  }

  // ── CHATHISTORY (bouncer scrollback) ────────────────────────
  private cmd_CHATHISTORY(client: IrcClient, msg: IrcMessage): void {
    if (!this.requireRegistered(client)) return;
    const sub = (msg.params[0] ?? "").toUpperCase();
    const target = msg.params[1] ?? "";
    const limit = Math.min(Number(msg.params[msg.params.length - 1]) || 50, this.cfg.historyLimit);
    if (sub !== "LATEST" && sub !== "BEFORE") {
      client.send({ prefix: this.cfg.serverName, command: "FAIL", params: ["CHATHISTORY", "INVALID_PARAMS", sub] });
      return;
    }
    const rows = this.store.history(target, limit);
    const batchId = newId().slice(0, 8);
    const useBatch = client.hasCap("batch");
    if (useBatch) {
      client.send({ command: "BATCH", params: [`+${batchId}`, "chathistory", target] });
    }
    for (const row of rows) {
      const tags: Record<string, string> = { time: row.ts, msgid: row.msgid };
      if (useBatch) tags["batch"] = batchId;
      if (row.account) tags["account"] = row.account;
      if (row.encrypted) tags["+kernel.org/enc"] = "1";
      client.send(
        { prefix: `${row.sender}!*@kernel`, command: row.kind, params: [target, row.payload] },
        tags,
      );
    }
    if (useBatch) client.send({ command: "BATCH", params: [`-${batchId}`] });
  }

  // ── misc commands ───────────────────────────────────────────
  private cmd_PING(client: IrcClient, msg: IrcMessage): void {
    client.send({ prefix: this.cfg.serverName, command: "PONG", params: [this.cfg.serverName, msg.params[0] ?? ""] });
  }
  private cmd_PONG(): void {}

  private cmd_QUIT(client: IrcClient, msg: IrcMessage): void {
    const reason = msg.params[0] ?? "Client quit";
    client.raw(`ERROR :Closing link: ${reason}`);
    this.disconnect(client, `Quit: ${reason}`);
  }

  private cmd_AWAY(client: IrcClient, msg: IrcMessage): void {
    if (!this.requireRegistered(client)) return;
    const text = msg.params[0];
    if (text) {
      client.away = text;
      client.numeric(this.cfg.serverName, RPL.NOWAWAY, "You have been marked as being away");
    } else {
      client.away = null;
      client.numeric(this.cfg.serverName, RPL.UNAWAY, "You are no longer marked as being away");
    }
    // away-notify
    for (const chan of this.channels.values()) {
      if (!chan.members.has(client.id)) continue;
      for (const m of chan.members.values()) {
        if (m.client.id === client.id || !m.client.hasCap("away-notify")) continue;
        m.client.send({ prefix: client.mask(), command: "AWAY", params: text ? [text] : [] });
      }
    }
  }

  private cmd_WHOIS(client: IrcClient, msg: IrcMessage): void {
    if (!this.requireRegistered(client)) return;
    const sn = this.cfg.serverName;
    const targetNick = msg.params[msg.params.length - 1] ?? "";
    const t = this.nicks.get(targetNick.toLowerCase());
    if (!t) {
      client.numeric(sn, ERR.NOSUCHNICK, targetNick, "No such nick");
      client.numeric(sn, RPL.ENDOFWHOIS, targetNick, "End of /WHOIS list");
      return;
    }
    client.numeric(sn, RPL.WHOISUSER, t.nick, t.user || "~" + t.nick, t.host, "*", t.realname || (t.isAgent ? "kernel agent" : ""));
    client.numeric(sn, RPL.WHOISSERVER, t.nick, sn, "Kernl");
    if (t.account) client.numeric(sn, RPL.WHOISACCOUNT, t.nick, t.account, "is logged in as");
    const chans = [...this.channels.values()].filter((c) => c.members.has(t.id)).map((c) => c.name);
    if (chans.length) client.numeric(sn, RPL.WHOISCHANNELS, t.nick, chans.join(" "));
    client.numeric(sn, RPL.ENDOFWHOIS, t.nick, "End of /WHOIS list");
  }

  private cmd_WHO(client: IrcClient, msg: IrcMessage): void {
    if (!this.requireRegistered(client)) return;
    const sn = this.cfg.serverName;
    const mask = msg.params[0] ?? "*";
    const chan = this.channels.get(mask.toLowerCase());
    if (chan) {
      for (const m of chan.members.values()) {
        const c = m.client;
        client.numeric(
          sn,
          RPL.WHOREPLY,
          chan.name,
          c.user || "~" + c.nick,
          c.host,
          sn,
          c.nick,
          (c.away ? "G" : "H") + (m.prefix || ""),
          `0 ${c.realname || c.nick}`,
        );
      }
    }
    client.numeric(sn, RPL.ENDOFWHO, mask, "End of /WHO list");
  }

  private cmd_ISON(client: IrcClient, msg: IrcMessage): void {
    if (!this.requireRegistered(client)) return;
    const present = msg.params.filter((n) => this.nicks.has(n.toLowerCase()));
    client.numeric(this.cfg.serverName, RPL.ISON, present.join(" "));
  }

  private cmd_MODE(client: IrcClient, msg: IrcMessage): void {
    if (!this.requireRegistered(client)) return;
    const target = msg.params[0] ?? "";
    if (!target.startsWith("#")) {
      // user mode — accept silently
      client.numeric(this.cfg.serverName, RPL.UMODEIS, "+i");
      return;
    }
    const chan = this.channels.get(target.toLowerCase());
    if (!chan) {
      client.numeric(this.cfg.serverName, ERR.NOSUCHCHANNEL, target, "No such channel");
      return;
    }
    if (msg.params.length < 2) {
      const modes = "+nt" + (chan.e2e ? "E" : "");
      client.numeric(this.cfg.serverName, RPL.CHANNELMODEIS, chan.name, modes);
      return;
    }
    // Apply a small set of channel modes (op/voice/e2e/ban).
    this.applyChannelModes(client, chan, msg.params.slice(1));
  }

  private applyChannelModes(client: IrcClient, chan: Channel, args: string[]): void {
    const me = chan.members.get(client.id);
    const isOp = me?.prefix.includes("@");
    if (!isOp && !client.isAgent) {
      client.numeric(this.cfg.serverName, ERR.CHANOPRIVSNEEDED, chan.name, "You're not channel operator");
      return;
    }
    const spec = args[0];
    let adding = true;
    let argIdx = 1;
    const applied: string[] = [];
    const appliedArgs: string[] = [];
    for (const ch of spec) {
      if (ch === "+") { adding = true; continue; }
      if (ch === "-") { adding = false; continue; }
      if (ch === "E") {
        chan.e2e = adding;
        applied.push((adding ? "+" : "-") + "E");
      } else if (ch === "o" || ch === "v") {
        const nick = args[argIdx++];
        const targetMember = [...chan.members.values()].find((m) => m.client.nick.toLowerCase() === (nick ?? "").toLowerCase());
        if (targetMember) {
          const sym = ch === "o" ? "@" : "+";
          targetMember.prefix = adding
            ? (targetMember.prefix.includes(sym) ? targetMember.prefix : sym + targetMember.prefix)
            : targetMember.prefix.replace(sym, "");
          applied.push((adding ? "+" : "-") + ch);
          appliedArgs.push(nick);
        }
      } else if (ch === "b") {
        const mask = args[argIdx++];
        if (mask && adding) {
          this.store.addBan(chan.name, mask, client.nick);
          applied.push("+b");
          appliedArgs.push(mask);
        }
      }
    }
    if (applied.length) {
      this.broadcastToChannel(chan, {
        prefix: client.mask(),
        command: "MODE",
        params: [chan.name, applied.join(""), ...appliedArgs],
      });
    }
  }

  private cmd_KICK(client: IrcClient, msg: IrcMessage): void {
    if (!this.requireRegistered(client)) return;
    const chan = this.channels.get((msg.params[0] ?? "").toLowerCase());
    const targetNick = msg.params[1] ?? "";
    if (!chan) {
      client.numeric(this.cfg.serverName, ERR.NOSUCHCHANNEL, msg.params[0] ?? "", "No such channel");
      return;
    }
    const me = chan.members.get(client.id);
    if (!me?.prefix.includes("@") && !client.isAgent) {
      client.numeric(this.cfg.serverName, ERR.CHANOPRIVSNEEDED, chan.name, "You're not channel operator");
      return;
    }
    const victim = [...chan.members.values()].find((m) => m.client.nick.toLowerCase() === targetNick.toLowerCase());
    if (!victim) {
      client.numeric(this.cfg.serverName, ERR.USERNOTINCHANNEL, targetNick, chan.name, "They aren't on that channel");
      return;
    }
    this.broadcastToChannel(chan, {
      prefix: client.mask(),
      command: "KICK",
      params: [chan.name, victim.client.nick, msg.params[2] ?? client.nick],
    });
    chan.members.delete(victim.client.id);
    if (victim.client.account) this.store.removeMembership(chan.name, victim.client.account);
  }

  // ── broadcast helper ────────────────────────────────────────
  private broadcastToChannel(
    chan: Channel,
    msg: Partial<IrcMessage> & { command: string },
    exceptClientId?: string,
    account?: string,
  ): void {
    for (const m of chan.members.values()) {
      if (exceptClientId && m.client.id === exceptClientId) continue;
      const tags: Record<string, string> = {};
      if (account && m.client.hasCap("account-tag")) tags["account"] = account;
      m.client.send(msg, tags);
    }
  }

  private requireRegistered(client: IrcClient): boolean {
    if (!client.registered) {
      client.raw(`:${this.cfg.serverName} ${ERR.NEEDMOREPARAMS} ${client.nick} :You have not registered`);
      return false;
    }
    return true;
  }

  private realClientCount(): number {
    return [...this.clients.values()].filter((c) => !c.isAgent && c.registered).length;
  }

  // ── public API for bridges / agents / notifications ─────────

  /** Register a persistent pseudo-client for a kernel agent (no socket). */
  createAgentUser(nick: string, account: string, realname = "kernel agent"): IrcClient {
    const existing = this.nicks.get(nick.toLowerCase());
    if (existing) return existing;
    const c = new IrcClient({ host: "kernel", sink: () => {} });
    c.nick = nick;
    c.user = account;
    c.realname = realname;
    c.account = account;
    c.isAgent = true;
    c.registered = true;
    c.gotNick = true;
    c.gotUser = true;
    this.clients.set(c.id, c);
    this.nicks.set(nick.toLowerCase(), c);
    this.store.upsertAccount({ account, nick, is_agent: true });
    return c;
  }

  // ── upstream relay support ──────────────────────────────────

  /** Ensure a plain (non-office) channel exists. Used for mirrored upstream channels. */
  ensureChannel(name: string): void {
    if (!name.startsWith("#")) name = "#" + name;
    const key = name.toLowerCase();
    if (this.channels.has(key)) return;
    const row = this.store.upsertChannel({ name });
    this.channels.set(key, {
      name,
      members: new Map(),
      topic: row.topic,
      topicBy: row.topic_by,
      topicAt: row.topic_at,
      e2e: row.e2e === 1,
      noExternal: true,
      isOffice: false,
    });
  }

  /**
   * Pseudo-client mirroring a user that lives on an upstream network, so
   * NAMES/WHO/WHOIS work on upstream nicks. Flagged as non-real so it never
   * counts as a connected client.
   */
  ensureRelayUser(nick: string): IrcClient {
    const existing = this.nicks.get(nick.toLowerCase());
    if (existing) return existing;
    const c = new IrcClient({ host: "upstream", sink: () => {} });
    c.nick = nick;
    c.user = "relay";
    c.realname = nick;
    c.isAgent = true;
    c.registered = true;
    c.gotNick = true;
    c.gotUser = true;
    this.clients.set(c.id, c);
    this.nicks.set(nick.toLowerCase(), c);
    return c;
  }

  /** Put a relay pseudo-user in a mirrored channel's member list. */
  addRelayMember(nick: string, channel: string, prefix = ""): void {
    const chan = this.channels.get(channel.toLowerCase());
    if (!chan) return;
    const c = this.ensureRelayUser(nick);
    if (!chan.members.has(c.id)) chan.members.set(c.id, { client: c, prefix });
  }

  /** Remove a relay pseudo-user from a mirrored channel. */
  removeRelayMember(nick: string, channel: string): void {
    const chan = this.channels.get(channel.toLowerCase());
    const c = this.nicks.get(nick.toLowerCase());
    if (!chan || !c) return;
    chan.members.delete(c.id);
  }

  /** Drop a relay pseudo-user entirely (upstream QUIT). */
  removeRelayUser(nick: string): void {
    const c = this.nicks.get(nick.toLowerCase());
    if (!c || !c.isAgent) return;
    for (const chan of this.channels.values()) chan.members.delete(c.id);
    this.nicks.delete(nick.toLowerCase());
    this.clients.delete(c.id);
  }

  /** Every live session of an account — where a relayed private message goes. */
  clientsForAccount(account: string): IrcClient[] {
    if (!account) return [];
    return [...this.clients.values()].filter((c) => c.account === account && !c.isAgent);
  }

  /**
   * Sessions belonging to an upstream owner. An owner is a SASL account when
   * the server has authentication configured, and a plain nick when it does
   * not — otherwise a kernel with no SASL password has no way to own anything.
   */
  clientsForOwner(owner: string): IrcClient[] {
    if (!owner) return [];
    return [...this.clients.values()].filter(
      (c) => !c.isAgent && (c.account ? c.account === owner : c.nick === owner),
    );
  }

  /** Ensure an office channel exists and is mapped. */
  ensureOfficeChannel(name: string, flow: string): void {
    if (!name.startsWith("#")) name = "#" + name;
    const row = this.store.upsertChannel({ name, is_office: true, office_flow: flow });
    const key = name.toLowerCase();
    if (!this.channels.has(key)) {
      this.channels.set(key, {
        name,
        members: new Map(),
        topic: row.topic,
        topicBy: row.topic_by,
        topicAt: row.topic_at,
        e2e: row.e2e === 1,
        noExternal: true,
        isOffice: true,
        officeFlow: flow,
      });
    } else {
      const c = this.channels.get(key)!;
      c.isOffice = true;
      c.officeFlow = flow;
    }
  }

  /** Inject a message into a channel from a nick (agent reply, bridge, notification). */
  postToChannel(fromNick: string, channel: string, text: string, opts: { kind?: "PRIVMSG" | "NOTICE"; encrypted?: boolean } = {}): void {
    if (!channel.startsWith("#")) channel = "#" + channel;
    const chan = this.channels.get(channel.toLowerCase());
    if (!chan) return;
    const source = this.nicks.get(fromNick.toLowerCase());
    const prefix = source ? source.mask() : `${fromNick}!kernel@${this.cfg.serverName}`;
    const msgid = newId();
    const tags: Record<string, string> = { msgid };
    if (source?.account) tags["account"] = source.account;
    if (opts.encrypted) tags["+kernel.org/enc"] = "1";
    const out: Partial<IrcMessage> & { command: string } = { prefix, command: opts.kind ?? "PRIVMSG", params: [chan.name, text] };
    for (const m of chan.members.values()) m.client.send(out, tags);
    this.store.storeMessage({
      msgid,
      target: chan.name,
      sender: fromNick,
      account: source?.account ?? "",
      kind: opts.kind ?? "PRIVMSG",
      payload: text,
      encrypted: opts.encrypted,
    });
  }

  /** Send a direct NOTICE/PRIVMSG to a nick (used by NotificationProvider.sendTo). */
  postToNick(fromNick: string, nick: string, text: string, kind: "PRIVMSG" | "NOTICE" = "NOTICE"): boolean {
    const dest = this.nicks.get(nick.toLowerCase());
    if (!dest) return false;
    dest.send({ prefix: `${fromNick}!kernel@${this.cfg.serverName}`, command: kind, params: [dest.nick, text] }, { msgid: newId() });
    return true;
  }

  /** Broadcast a NOTICE to every channel (NotificationProvider.sendNotification). */
  broadcastNotice(fromNick: string, text: string): number {
    let n = 0;
    for (const chan of this.channels.values()) {
      this.postToChannel(fromNick, chan.name, text, { kind: "NOTICE" });
      n++;
    }
    return n;
  }

  stats(): { clients: number; agents: number; channels: number; nicks: number } {
    return {
      clients: this.realClientCount(),
      agents: [...this.clients.values()].filter((c) => c.isAgent).length,
      channels: this.channels.size,
      nicks: this.nicks.size,
    };
  }

  listChannelNames(): { name: string; members: number; topic: string; office: boolean; e2e: boolean }[] {
    return [...this.channels.values()].map((c) => ({
      name: c.name,
      members: c.members.size,
      topic: c.topic,
      office: c.isOffice,
      e2e: c.e2e,
    }));
  }
}

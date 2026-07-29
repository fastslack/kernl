/**
 * IrcClient — a single connected session, agnostic to the underlying byte
 * transport (TLS socket or WebSocket). The transport injects a `sink` that
 * writes a raw line, and feeds inbound chunks through `feed()`.
 */
import { parseLine, serialize, splitLines, type IrcMessage } from "./parser.js";

export interface ClientSendOptions {
  /** Skip echoing this exact line back to the sender even with echo-message. */
  noEcho?: boolean;
}

let SEQ = 0;

export class IrcClient {
  readonly id: string;
  /** Raw line sink into the transport (already terminated by the transport). */
  private sink: (line: string) => void;

  nick = "*";
  user = "";
  realname = "";
  host: string;
  registered = false;
  gotNick = false;
  gotUser = false;

  /** Negotiated IRCv3 capabilities. */
  caps = new Set<string>();
  /** True between `CAP LS`/`CAP REQ` and `CAP END` — registration is paused. */
  capNegotiating = false;

  /** SASL */
  saslMech: string | null = null;
  account: string | null = null;
  /** TLS client-cert SHA-256 fingerprint (hex, lowercase, no colons). */
  certFingerprint?: string;

  away: string | null = null;
  isAgent = false;
  /** Bytes received, for flood accounting. */
  recvCount = 0;

  private buffer = "";

  constructor(opts: { host: string; sink: (line: string) => void; certFingerprint?: string }) {
    this.id = `c${++SEQ}`;
    this.host = opts.host;
    this.sink = opts.sink;
    this.certFingerprint = opts.certFingerprint;
  }

  /** Feed a raw inbound chunk; returns the complete parsed messages. */
  feed(chunk: string): IrcMessage[] {
    this.buffer += chunk;
    const { lines, rest } = splitLines(this.buffer);
    this.buffer = rest;
    // Guard against an unbounded line (flood / malformed client).
    if (this.buffer.length > 8192) this.buffer = "";
    const out: IrcMessage[] = [];
    for (const line of lines) {
      this.recvCount++;
      const msg = parseLine(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  hasCap(name: string): boolean {
    return this.caps.has(name);
  }

  /** Full nick!user@host mask. */
  mask(): string {
    return `${this.nick}!${this.user || "~" + this.nick}@${this.host}`;
  }

  /** Send a structured message. Adds server-time/account tags when negotiated. */
  send(msg: Partial<IrcMessage> & { command: string }, tags?: Record<string, string>): void {
    const merged: Record<string, string> = { ...(msg.tags ?? {}), ...(tags ?? {}) };
    if (this.hasCap("server-time") && !merged["time"]) {
      merged["time"] = new Date().toISOString();
    }
    // Only emit tags the client asked for (message-tags is the umbrella cap).
    const allowTags = this.hasCap("message-tags") || this.hasCap("server-time") || this.hasCap("account-tag");
    const line = serialize({ ...msg, tags: allowTags ? merged : {} });
    this.sink(line);
  }

  /** Send a numeric reply (server prefix + nick as first param). */
  numeric(serverName: string, code: string, ...params: string[]): void {
    this.send({ prefix: serverName, command: code, params: [this.nick, ...params] });
  }

  raw(line: string): void {
    this.sink(line);
  }
}

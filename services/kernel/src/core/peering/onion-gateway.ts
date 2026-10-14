/**
 * The only thing the onion address reaches.
 *
 * The onion is public — it travels in the presence we publish to open Nostr
 * relays, so anyone can read it — and Tor delivers every connection on
 * 127.0.0.1. Pointing the hidden service at the kernel's own port made the
 * whole dashboard, /mcp and the unauthenticated /api/health and /api/metrics
 * (timezone, uptime, counts) reachable from the internet, with the owner token
 * as the single barrier, and exempt from the rate limit, which trusts loopback.
 *
 * So the hidden service forwards here instead: a separate loopback listener
 * that serves the presence card and nothing else unless the operator turns a
 * service on, from the Friends page. Each service is a short list of path
 * prefixes that already authenticate the caller themselves (a NIP-98
 * signature from a trusted friend, or a per-endpoint token). Anything else is
 * a bare 404 that says nothing about what runs behind it.
 *
 * The path is normalized here exactly as the kernel's router will normalize
 * it, and the request is rewritten to that form before it is handed over, so
 * `/api/peering/transfer/../friends` cannot reach an owner route.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SqliteDb } from "../db/sqlite.js";
import { log } from "../logger.js";

export const ONION_SERVICES_KEY = "peering.onion.services";
export const DEFAULT_GATEWAY_PORT = 3090;

export interface OnionService {
  id: string;
  label: string;
  description: string;
  /** Path prefixes this service opens (exact match or followed by "/"). */
  prefixes: string[];
  /** On when the operator has not chosen yet. */
  defaultOn: boolean;
  /** Always served; the switch is shown but cannot be turned off. */
  locked?: boolean;
}

export const ONION_SERVICES: OnionService[] = [
  {
    id: "presence",
    label: "Presence card",
    description: "Your signed card: name, key and how to reach you. A friend needs it to check it is really you.",
    prefixes: ["/.well-known/kernl"],
    defaultOn: true,
    locked: true,
  },
  {
    id: "friends",
    label: "Files, texts and Social identity with friends",
    description: "Trusted friends can send you files and texts and learn which Social persona is yours. Each request is signed by them.",
    prefixes: ["/api/peering/transfer", "/api/peering/persona"],
    defaultOn: true,
  },
  {
    id: "relay",
    label: "Bridge between friends",
    description: "Carry requests between two of your friends who cannot reach each other directly.",
    prefixes: ["/api/peering/relay"],
    defaultOn: false,
  },
  {
    id: "cinema",
    label: "Cinema catalogue",
    description: "Trusted friends can browse the cinema directories you share with them.",
    prefixes: ["/api/cinema/directories/friend-view"],
    defaultOn: false,
  },
  {
    id: "apple-health",
    label: "iPhone · Apple Health",
    description: "Your phone can push health samples from any network, with the token you created for it.",
    prefixes: ["/api/apple-health/push"],
    defaultOn: false,
  },
];

export interface OnionServiceView {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  locked: boolean;
}

export interface OnionGatewayOptions {
  sqlite: SqliteDb;
  /** The kernel's own dispatcher (KernelHttpServer.dispatch). */
  dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  port?: number;
  /** Requests per minute across the whole gateway. Tor hides who is asking, so there is one budget. */
  perMinute?: number;
  now?: () => number;
}

const NOT_FOUND = JSON.stringify({ error: "Not found" });
const BARE_HEADERS = {
  "Content-Type": "application/json",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

export class OnionGateway {
  private server: Server | null = null;
  private windowStart = 0;
  private count = 0;
  readonly port: number;

  constructor(private opts: OnionGatewayOptions) {
    this.port = opts.port ?? Number(process.env.KERNEL_ONION_GATEWAY_PORT ?? DEFAULT_GATEWAY_PORT);
  }

  /** The operator's choice, or each service's default when they never chose. */
  enabledIds(): Set<string> {
    let chosen: string[] | null = null;
    try {
      const row = this.opts.sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(ONION_SERVICES_KEY) as
        | { value: string }
        | undefined;
      if (row?.value) {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) chosen = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      /* unreadable choice: fall back to the defaults rather than open anything */
    }
    const ids = new Set(chosen ?? ONION_SERVICES.filter((s) => s.defaultOn).map((s) => s.id));
    for (const s of ONION_SERVICES) if (s.locked) ids.add(s.id);
    return ids;
  }

  services(): OnionServiceView[] {
    const on = this.enabledIds();
    return ONION_SERVICES.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      enabled: on.has(s.id),
      locked: !!s.locked,
    }));
  }

  setService(id: string, enabled: boolean): OnionServiceView[] {
    const svc = ONION_SERVICES.find((s) => s.id === id);
    if (!svc) throw new Error(`unknown service "${id}"`);
    if (svc.locked) throw new Error(`"${svc.label}" is always published`);
    const on = this.enabledIds();
    if (enabled) on.add(id);
    else on.delete(id);
    this.opts.sqlite
      .prepare(
        `INSERT INTO app_settings (key, value, type, label, description, category, updated_at, updated_by)
         VALUES (?, ?, 'json', 'Published over the onion', ?, 'integrations', ?, 'user')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = 'user'`,
      )
      .run(
        ONION_SERVICES_KEY,
        JSON.stringify([...on].filter((x) => !ONION_SERVICES.find((s) => s.id === x)?.locked).sort()),
        "Which services the onion address serves. Chosen from the Friends page; everything else answers 404.",
        new Date().toISOString(),
      );
    return this.services();
  }

  /** Is this (already normalized) path inside a published service? */
  allows(pathname: string): boolean {
    const on = this.enabledIds();
    return ONION_SERVICES.some(
      (s) => on.has(s.id) && s.prefixes.some((p) => pathname === p || pathname.startsWith(p + "/")),
    );
  }

  private overBudget(): boolean {
    const now = (this.opts.now ?? Date.now)();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count++;
    return this.count > (this.opts.perMinute ?? 600);
  }

  /** The gateway's request handler, exported for the tests. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname: string;
    let search: string;
    try {
      // Same parser the kernel's router uses, so both see the same path.
      const url = new URL(req.url ?? "/", "http://onion.invalid");
      pathname = url.pathname;
      search = url.search;
    } catch {
      res.writeHead(400, BARE_HEADERS);
      res.end(JSON.stringify({ error: "Bad request" }));
      return;
    }

    if (this.overBudget()) {
      res.writeHead(429, BARE_HEADERS);
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }

    // An encoded slash or backslash would let a segment mean two things to
    // two parsers. No published route needs one.
    if (/%2f|%5c|\\/i.test(req.url ?? "") || req.method === "OPTIONS" || !this.allows(pathname)) {
      res.writeHead(404, BARE_HEADERS);
      res.end(NOT_FOUND);
      return;
    }

    // The owner's credentials never ride the onion: published routes
    // authenticate the caller by their own means.
    delete req.headers.authorization;
    delete req.headers.cookie;
    req.url = pathname + search;
    await this.opts.dispatch(req, res);
  }

  start(): Promise<boolean> {
    if (this.server) return Promise.resolve(true);
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          log.warn("onion gateway: request failed", err);
          if (!res.headersSent) {
            res.writeHead(500, BARE_HEADERS);
            res.end(JSON.stringify({ error: "Internal error" }));
          }
        });
      });
      server.once("error", (err) => {
        log.warn(`onion gateway: cannot listen on 127.0.0.1:${this.port} — the onion will serve nothing`, err);
        resolve(false);
      });
      // Loopback only: tor connects from this machine, nobody else should.
      server.listen(this.port, "127.0.0.1", () => {
        this.server = server;
        log.info(`onion gateway: listening on 127.0.0.1:${this.port}`);
        resolve(true);
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}

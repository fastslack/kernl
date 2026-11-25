/**
 * The dashboard's live socket on a native install.
 *
 * The dashboard opens `ws://<its own host>/mtw`. In Docker nginx answers that
 * path: it asks the kernel first (`auth_request` → /api/auth/broker) and then
 * proxies to mtwRequest's `/ws`. A binary install (macOS .app, Linux, Windows)
 * has no nginx: the kernel serves the SPA itself and runs mtw-server as a
 * sidecar on loopback, so without this the socket never opens and every page
 * falls back to polling ("POLL", "sin conexión en vivo").
 *
 * The same two gates as in Docker: the kernel decides here who may open it,
 * and mtw-server (>= 0.5.0) asks the kernel again on the handshake, from the
 * `?token=` that is passed on untouched.
 *
 * It relays WebSocket messages rather than raw bytes: under Bun, what is
 * written to the socket of a node:http `upgrade` event never reaches the
 * client, while `ws`'s handleUpgrade works on both runtimes.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export interface LiveSocketUpstream {
  host: string;
  port: number;
  /** The broker's WebSocket path (mtw.toml `[transport.websocket] path`). */
  path: string;
}

/** The dashboard's path for the live socket. */
export const LIVE_SOCKET_PATH = "/mtw";

/** Who the kernel lets onto the broker: 204/200 pass, anything else is refused with it. */
export type LiveSocketDecision = 200 | 204 | 401 | 403;

const REASONS: Record<number, string> = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 502: "Bad Gateway" };

/** No HTTP server of its own: sockets arrive through handleUpgrade. */
let acceptor: WebSocketServer | null = null;
function wss(): WebSocketServer {
  acceptor ??= new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });
  return acceptor;
}

function refuse(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  // Node sends this; Bun drops it and the client just sees the handshake fail.
  socket.end(`HTTP/1.1 ${status} ${REASONS[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  setTimeout(() => socket.destroy(), 500).unref();
}

/** The broker's URL for this request: its own path, the dashboard's query (the token rides there). */
export function upstreamUrl(req: IncomingMessage, upstream: LiveSocketUpstream): string {
  const raw = req.url ?? LIVE_SOCKET_PATH;
  const q = raw.indexOf("?");
  return `ws://${upstream.host}:${upstream.port}${upstream.path}${q >= 0 ? raw.slice(q) : ""}`;
}

/** 1005 and 1006 are reported, never sent; anything else outside the sendable ranges closes plainly. */
function sendableCode(code: number): number | undefined {
  return code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
    ? code : undefined;
}

function relay(from: WebSocket, to: WebSocket): void {
  from.on("message", (data: RawData, isBinary: boolean) => {
    if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
  });
  from.on("close", (code: number, reason: Buffer) => {
    if (to.readyState === WebSocket.OPEN || to.readyState === WebSocket.CONNECTING) {
      const c = sendableCode(code);
      if (c === undefined) to.close(); else to.close(c, reason);
    }
  });
  from.on("error", () => to.terminate());
}

/**
 * Handle one HTTP upgrade. Returns false when the path is not the live
 * socket's, so the caller can refuse it as it would any other.
 */
export function proxyLiveSocket(opts: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  upstream: LiveSocketUpstream | null;
  decide: (req: IncomingMessage) => LiveSocketDecision;
}): boolean {
  const { req, socket, head, upstream } = opts;
  const pathname = (req.url ?? "").split("?")[0];
  if (pathname !== LIVE_SOCKET_PATH) return false;
  if (!upstream) { refuse(socket, 404); return true; }

  const decision = opts.decide(req);
  if (decision !== 200 && decision !== 204) { refuse(socket, decision); return true; }

  // The broker first: if it is down or refuses, so does this handshake, and
  // the dashboard keeps polling and retrying instead of holding a dead socket.
  const broker = new WebSocket(upstreamUrl(req, upstream), { perMessageDeflate: false });
  let settled = false;
  const gaveUp = () => { if (!settled) { settled = true; refuse(socket, 502); } };
  broker.once("unexpected-response", (_r, res) => { res.resume(); broker.terminate(); gaveUp(); });
  broker.on("error", gaveUp);
  socket.once("close", () => { if (!settled) { settled = true; broker.terminate(); } });
  broker.once("open", () => {
    if (settled) { broker.close(); return; }
    settled = true;
    wss().handleUpgrade(req, socket, head, (client) => {
      relay(client, broker);
      relay(broker, client);
    });
  });
  return true;
}

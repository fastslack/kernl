import { describe, it, expect, afterEach } from "vitest";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { createServer as createNet, type Server as NetServer, type AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { proxyLiveSocket, upstreamUrl, type LiveSocketDecision } from "../src/core/live-socket-proxy.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

function listen(server: HttpServer | NetServer): Promise<number> {
  return new Promise(ok => server.listen(0, "127.0.0.1", () => ok((server.address() as AddressInfo).port)));
}

/** A broker that records each handshake's URL and echoes messages back with a prefix. */
async function fakeBroker(): Promise<{ port: number; urls: string[]; sockets: WebSocket[] }> {
  const urls: string[] = [];
  const sockets: WebSocket[] = [];
  const http = createHttp();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws, req) => {
    urls.push(req.url ?? "");
    sockets.push(ws);
    ws.on("message", (m, isBinary) => ws.send(isBinary ? m : `broker:${m}`, { binary: isBinary }));
  });
  const port = await listen(http);
  // Not awaiting close(): Bun's waits forever on a socket that was upgraded.
  closers.push(async () => { for (const c of wss.clients) c.terminate(); wss.close(); http.closeAllConnections?.(); http.close(); });
  return { port, urls, sockets };
}

async function kernel(upstreamPort: number | null, decide: () => LiveSocketDecision): Promise<number> {
  const srv = createHttp((_req, res) => { res.writeHead(200); res.end("ok"); });
  srv.on("upgrade", (req, socket, head) => {
    const handled = proxyLiveSocket({
      req, socket, head, decide,
      upstream: upstreamPort === null ? null : { host: "127.0.0.1", port: upstreamPort, path: "/ws" },
    });
    if (!handled) socket.destroy();
  });
  const port = await listen(srv);
  closers.push(async () => { srv.closeAllConnections?.(); srv.close(); });
  return port;
}

/** Open a dashboard-side socket; resolves to it once open, or to null if the handshake fails. */
function open(port: number, path: string): Promise<WebSocket | null> {
  return new Promise(ok => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const t = setTimeout(() => { ws.terminate(); ok(null); }, 3000);
    ws.once("open", () => { clearTimeout(t); closers.push(async () => ws.terminate()); ok(ws); });
    ws.once("error", () => { clearTimeout(t); ok(null); });
    ws.once("unexpected-response", () => { clearTimeout(t); ws.terminate(); ok(null); });
  });
}

/**
 * Messages in arrival order. One listener for the socket's life: under Bun a
 * second `once("message")` added from inside a message handler never fires.
 */
function inbox(ws: WebSocket): () => Promise<{ data: string; binary: boolean }> {
  const got: Array<{ data: string; binary: boolean }> = [];
  const waiting: Array<(m: { data: string; binary: boolean }) => void> = [];
  ws.on("message", (d, binary) => {
    const m = { data: binary ? Buffer.from(d as Buffer).toString("hex") : String(d), binary };
    const w = waiting.shift();
    if (w) w(m); else got.push(m);
  });
  return () => new Promise(ok => { const m = got.shift(); if (m) ok(m); else waiting.push(ok); });
}

describe("live socket proxy (/mtw on a native install)", () => {
  it("opens the broker's path with the query kept and relays both ways", async () => {
    const broker = await fakeBroker();
    const port = await kernel(broker.port, () => 204);
    const ws = await open(port, "/mtw?token=abc");
    expect(ws).not.toBeNull();
    expect(broker.urls).toEqual(["/ws?token=abc"]);

    const next = inbox(ws!);
    ws!.send("ping");
    expect(await next()).toEqual({ data: "broker:ping", binary: false });

    ws!.send(Buffer.from([1, 2, 3]));
    expect(await next()).toEqual({ data: "010203", binary: true });

    broker.sockets[0].send("from the bus");
    expect((await next()).data).toBe("from the bus");
  });

  it("closes the dashboard's socket when the broker goes away", async () => {
    const broker = await fakeBroker();
    const port = await kernel(broker.port, () => 204);
    const ws = await open(port, "/mtw");
    const closed = new Promise<void>(ok => ws!.once("close", () => ok()));
    broker.sockets[0].close(1001, "bye");
    await closed;
  });

  it("lets a user through when the kernel says 200", async () => {
    const broker = await fakeBroker();
    const port = await kernel(broker.port, () => 200);
    expect(await open(port, "/mtw?token=u")).not.toBeNull();
  });

  it("refuses when the kernel does, without dialling the broker", async () => {
    const broker = await fakeBroker();
    for (const status of [401, 403] as const) {
      const port = await kernel(broker.port, () => status);
      expect(await open(port, "/mtw")).toBeNull();
    }
    expect(broker.urls).toHaveLength(0);
  });

  it("refuses when there is no broker of its own (Docker: nginx owns /mtw)", async () => {
    const port = await kernel(null, () => 204);
    expect(await open(port, "/mtw")).toBeNull();
  });

  it("refuses when the broker is down", async () => {
    const probe = createNet();
    const dead = await listen(probe);
    await new Promise<void>(ok => probe.close(() => ok()));
    const port = await kernel(dead, () => 204);
    expect(await open(port, "/mtw")).toBeNull();
  });

  it("leaves other upgrade paths to the caller", async () => {
    const broker = await fakeBroker();
    const port = await kernel(broker.port, () => 204);
    expect(await open(port, "/other")).toBeNull();
    expect(broker.urls).toHaveLength(0);
  });

  it("builds the broker's URL without a query when there is none", () => {
    const up = { host: "127.0.0.1", port: 7741, path: "/ws" };
    expect(upstreamUrl({ url: "/mtw" } as never, up)).toBe("ws://127.0.0.1:7741/ws");
    expect(upstreamUrl({ url: "/mtw?token=a%20b" } as never, up)).toBe("ws://127.0.0.1:7741/ws?token=a%20b");
  });
});

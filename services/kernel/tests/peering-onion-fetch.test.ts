/**
 * The onion client: the CONNECT handshake and the HTTP conversation on top.
 *
 * A fake CONNECT proxy stands in for tor, so this runs anywhere and in
 * milliseconds — but it is the real code path, sockets included.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { onionFetch, openTunnel } from "../src/core/peering/onion-fetch.js";
import { makeTorAwareFetch } from "../src/core/peering/tor.js";

interface FakeProxy {
  port: number;
  server: Server;
  /** CONNECT targets the proxy was asked for, in order. */
  targets: string[];
  close(): Promise<void>;
}

/**
 * A proxy that answers CONNECT and then plays the origin server itself,
 * which is exactly the shape tor presents.
 */
async function startFakeProxy(opts: {
  status?: number;
  body?: string;
  refuse?: boolean;
  echoRequestLine?: boolean;
}): Promise<FakeProxy> {
  const targets: string[] = [];
  const server = createServer((socket: Socket) => {
    let preamble = "";
    const onData = (chunk: Buffer) => {
      preamble += chunk.toString("latin1");
      if (!preamble.includes("\r\n\r\n")) return;
      socket.removeListener("data", onData);

      const line = preamble.slice(0, preamble.indexOf("\r\n"));
      targets.push(line.split(" ")[1] ?? "");
      if (opts.refuse) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        return;
      }
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");

      // Now behave like the origin: read the tunnelled request, answer it.
      let inner = "";
      socket.on("data", (c: Buffer) => {
        inner += c.toString("latin1");
        if (!inner.includes("\r\n\r\n")) return;
        const requestLine = inner.slice(0, inner.indexOf("\r\n"));
        const payload = opts.echoRequestLine ? requestLine : (opts.body ?? '{"ok":true}');
        socket.end(
          `HTTP/1.1 ${opts.status ?? 200} OK\r\n` +
            `content-type: application/json\r\n` +
            `content-length: ${Buffer.byteLength(payload)}\r\n\r\n` +
            payload,
        );
      });
    };
    socket.on("data", onData);
    socket.on("error", () => undefined);
  });

  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    server,
    targets,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

let proxy: FakeProxy | null = null;
afterEach(async () => {
  await proxy?.close();
  proxy = null;
});

describe("onion fetch over CONNECT", () => {
  it("tunnels a GET and returns the body", async () => {
    proxy = await startFakeProxy({ body: '{"kernl":1}' });
    const res = await onionFetch("http://abcdefghij.onion/.well-known/kernl", undefined, {
      proxyHost: "127.0.0.1",
      proxyPort: proxy.port,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kernl: 1 });
    // tor is asked for the onion by name — never resolved locally.
    expect(proxy.targets[0]).toBe("abcdefghij.onion:80");
  });

  it("sends the path and method through the tunnel intact", async () => {
    proxy = await startFakeProxy({ echoRequestLine: true });
    const res = await onionFetch("http://abc.onion/api/x?y=1", { method: "POST", body: "{}" }, {
      proxyHost: "127.0.0.1",
      proxyPort: proxy.port,
    });
    expect(await res.text()).toBe("POST /api/x?y=1 HTTP/1.1");
  });

  it("passes headers, which is how NIP-98 auth survives the hop", async () => {
    proxy = await startFakeProxy({ body: "ok" });
    const res = await onionFetch(
      "http://abc.onion/x",
      { headers: { authorization: "Nostr abc123" } },
      { proxyHost: "127.0.0.1", proxyPort: proxy.port },
    );
    expect(res.status).toBe(200);
  });

  it("surfaces a refused tunnel as an error", async () => {
    proxy = await startFakeProxy({ refuse: true });
    await expect(
      onionFetch("http://abc.onion/x", undefined, {
        proxyHost: "127.0.0.1",
        proxyPort: proxy.port,
      }),
    ).rejects.toThrow("tor refused the tunnel");
  });

  it("fails fast when nothing is listening", async () => {
    await expect(
      openTunnel({ proxyHost: "127.0.0.1", proxyPort: 1 }, "abc.onion", 80),
    ).rejects.toThrow();
  });

  it("refuses https, which no onion can serve", async () => {
    proxy = await startFakeProxy({});
    await expect(
      onionFetch("https://abc.onion/x", undefined, {
        proxyHost: "127.0.0.1",
        proxyPort: proxy.port,
      }),
    ).rejects.toThrow("must be http");
  });

  it("honours an abort signal", async () => {
    proxy = await startFakeProxy({ body: "slow" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      onionFetch("http://abc.onion/x", { signal: controller.signal }, {
        proxyHost: "127.0.0.1",
        proxyPort: proxy.port,
      }),
    ).rejects.toThrow();
  });
});

describe("tor-aware fetch routing", () => {
  it("sends clearnet straight out and onion through the tunnel", async () => {
    proxy = await startFakeProxy({ body: '{"via":"onion"}' });
    let clearnetCalls = 0;
    const base = (async () => {
      clearnetCalls++;
      return new Response('{"via":"clearnet"}');
    }) as unknown as typeof fetch;

    const f = makeTorAwareFetch(base, `http://127.0.0.1:${proxy.port}`);

    expect(await (await f("https://example.com/x")).json()).toEqual({ via: "clearnet" });
    expect(clearnetCalls).toBe(1);

    expect(await (await f("http://abc.onion/x")).json()).toEqual({ via: "onion" });
    // The runtime fetch was never asked to deal with the onion.
    expect(clearnetCalls).toBe(1);
  });
});

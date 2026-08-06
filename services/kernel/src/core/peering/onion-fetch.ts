/**
 * Reaching a .onion from the kernel.
 *
 * Neither of the obvious routes works under Bun: `fetch` rejects a socks5://
 * proxy outright (UnsupportedProxyProtocol), and tor's HTTPTunnelPort speaks
 * only CONNECT while Bun sends a plain absolute-URI GET for http:// targets,
 * which tor answers by closing the socket.
 *
 * So the CONNECT handshake is done here by hand — about forty lines and no new
 * dependency — and once the tunnel is open `node:http` speaks ordinary HTTP
 * over it. The onion hostname is resolved by tor, never by the system
 * resolver, which is both the only thing that works and the only thing that is
 * safe.
 */
import { connect as netConnect, type Socket } from "node:net";
import { gunzipSync, inflateSync } from "node:zlib";
import { log } from "../logger.js";

/**
 * Building a circuit to a hidden service is slow, and the first one after a
 * fresh tor start is the worst: measured at 46s against our own onion on a
 * cold daemon. A 30s budget aborted every attempt just before it succeeded,
 * which looked exactly like the peer being offline. Later connections reuse
 * circuits and land in a second or two.
 */
export const CONNECT_TIMEOUT_MS = 90_000;
export const RESPONSE_TIMEOUT_MS = 60_000;
/** A descriptor is a couple of KB; this cap is about a peer gone wrong. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface OnionFetchOptions {
  /** host:port of tor's HTTPTunnelPort. */
  proxyHost: string;
  proxyPort: number;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
}

/**
 * Open a TCP tunnel to `host:port` through tor's HTTP CONNECT proxy and hand
 * back the raw socket, already past the handshake.
 */
export function openTunnel(
  opts: OnionFetchOptions,
  host: string,
  port: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: opts.proxyHost, port: opts.proxyPort });
    let settled = false;
    let banner = "";

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error(`tor CONNECT to ${host} timed out`)),
      opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );

    const onData = (chunk: Buffer) => {
      banner += chunk.toString("latin1");
      const end = banner.indexOf("\r\n\r\n");
      if (end === -1) {
        // A proxy that never finishes its header would grow this forever.
        if (banner.length > 8192) fail(new Error("tor CONNECT reply is malformed"));
        return;
      }
      clearTimeout(timer);
      socket.removeListener("data", onData);

      const statusLine = banner.slice(0, banner.indexOf("\r\n"));
      const status = Number(statusLine.split(" ")[1]);
      if (status !== 200) {
        fail(new Error(`tor refused the tunnel: ${statusLine.trim()}`));
        return;
      }
      // Anything after the blank line already belongs to the tunnelled
      // conversation; push it back so the HTTP parser sees it.
      const leftover = banner.slice(end + 4);
      if (leftover.length > 0) socket.unshift(Buffer.from(leftover, "latin1"));

      settled = true;
      resolve(socket);
    };

    socket.on("data", onData);
    socket.once("error", (err) => {
      clearTimeout(timer);
      fail(err instanceof Error ? err : new Error(String(err)));
    });
    socket.once("connect", () => {
      // Host is mandatory in the CONNECT request for tor to route it.
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`,
      );
    });
  });
}

/**
 * fetch() for onion addresses. Same shape as the global so it can slot into
 * the peering client, and it throws on failure exactly like fetch does.
 */
export async function onionFetch(
  url: string,
  init: RequestInit | undefined,
  opts: OnionFetchOptions,
): Promise<Response> {
  const target = new URL(url);
  const port = target.port ? Number(target.port) : 80;
  if (target.protocol !== "http:") {
    // Onion services are already authenticated and encrypted by the protocol;
    // TLS on top would need a certificate no one can issue for .onion.
    throw new Error(`onion requests must be http://, got ${target.protocol}`);
  }

  const socket = await openTunnel(opts, target.hostname, port);

  const method = (init?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    host: target.host,
    // Both ends are Kernl and the payloads are small; closing after the
    // response is what makes "body until EOF" a valid fallback below.
    connection: "close",
    "accept-encoding": "identity",
  };
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
  }
  const body = typeof init?.body === "string" ? init.body : undefined;
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));

  return speakHttp(socket, {
    requestLine: `${method} ${target.pathname + target.search} HTTP/1.1`,
    headers,
    body,
    timeoutMs: opts.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS,
    signal: init?.signal ?? undefined,
    label: target.host,
  });
}

/**
 * Speak HTTP/1.1 over an already-open socket.
 *
 * Written by hand because Bun's `node:http` ignores `createConnection` and
 * tries to dial the target itself, which for an .onion can only ever fail.
 * The surface needed here is small and fully under our control: both ends are
 * Kernl instances exchanging a few KB of JSON.
 */
function speakHttp(
  socket: Socket,
  opts: {
    requestLine: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    label: string;
  },
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let raw = Buffer.alloc(0);
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const fail = (err: Error) => finish(() => reject(err));

    const timer = setTimeout(
      () => fail(new Error(`onion request to ${opts.label} timed out`)),
      opts.timeoutMs,
    );

    if (opts.signal) {
      if (opts.signal.aborted) return fail(new Error("aborted"));
      opts.signal.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
    }

    socket.on("data", (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
      if (raw.length > MAX_RESPONSE_BYTES) {
        fail(new Error("onion response exceeded the size cap"));
        return;
      }
      const parsed = tryParseResponse(raw);
      if (parsed) finish(() => resolve(parsed));
    });

    socket.on("end", () => {
      // A server that closed without a content-length still gave us the body.
      const parsed = tryParseResponse(raw, true);
      if (parsed) finish(() => resolve(parsed));
      else fail(new Error(`onion peer ${opts.label} closed the connection early`));
    });

    socket.on("error", (err) => {
      log.debug(`peering: onion socket to ${opts.label} failed: ${err.message}`);
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    const head =
      opts.requestLine +
      "\r\n" +
      Object.entries(opts.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n") +
      "\r\n\r\n";
    socket.write(head + (opts.body ?? ""));
  });
}

/**
 * Turn accumulated bytes into a Response once the whole message is present.
 * Returns null while it is still incomplete, so the caller can wait for more.
 */
function tryParseResponse(raw: Buffer, atEof = false): Response | null {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator === -1) return null;

  const headText = raw.subarray(0, separator).toString("latin1");
  const lines = headText.split("\r\n");
  const statusLine = lines[0] ?? "";
  const status = Number(statusLine.split(" ")[1]);
  if (!Number.isFinite(status)) return null;

  const headers = new Headers();
  const lower: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    lower[key.toLowerCase()] = value;
    try {
      headers.set(key, value);
    } catch {
      /* a header name the Headers API rejects is not worth failing over */
    }
  }

  const rest = raw.subarray(separator + 4);
  let body: Buffer;

  if ((lower["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) {
    const decoded = decodeChunked(rest);
    if (!decoded) return null; // still streaming
    body = decoded;
  } else if (lower["content-length"] !== undefined) {
    const expected = Number(lower["content-length"]);
    if (!Number.isFinite(expected)) return null;
    if (rest.length < expected) return null;
    body = rest.subarray(0, expected);
  } else if (atEof) {
    body = rest;
  } else {
    return null;
  }

  // We ask for identity, but a proxy or an older peer may compress anyway.
  const encoding = (lower["content-encoding"] ?? "").toLowerCase();
  try {
    if (encoding.includes("gzip")) body = gunzipSync(body);
    else if (encoding.includes("deflate")) body = inflateSync(body);
  } catch {
    return null;
  }

  // Response wants a web BodyInit; a Node Buffer is a Uint8Array view, so
  // copying it into a plain one is both correct and cheap at these sizes.
  return new Response(new Uint8Array(body), {
    status,
    statusText: statusLine.split(" ").slice(2).join(" "),
    headers,
  });
}

/** Decode a chunked body, or null when the terminating chunk has not arrived. */
function decodeChunked(buf: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buf.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    const size = parseInt(buf.subarray(offset, lineEnd).toString("latin1").split(";")[0], 16);
    if (!Number.isFinite(size)) return null;
    if (size === 0) return Buffer.concat(parts);
    const start = lineEnd + 2;
    const end = start + size;
    if (buf.length < end + 2) return null;
    parts.push(buf.subarray(start, end));
    offset = end + 2;
  }
}

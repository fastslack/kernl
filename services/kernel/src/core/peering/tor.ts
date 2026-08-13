/**
 * Tor onion support.
 *
 * The onion address is what makes an instance reachable behind CGNAT or a
 * tethered phone, and it costs no infrastructure: the Tor network already
 * exists and the address *is* the public key, so there is no DNS name to
 * register and no certificate to buy.
 *
 * The kernel does not run tor itself — that is the image's job. Here we only
 * notice whether a hidden service exists and where its SOCKS port is. Every
 * part of this degrades to "no onion entry" and nothing else breaks.
 */
import { existsSync, readFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { resolve } from "node:path";
import { log } from "../logger.js";
import { onionFetch } from "./onion-fetch.js";

/** Where the hidden service keeps its hostname, inside the data volume. */
export const DEFAULT_HIDDEN_SERVICE_DIR = "data/tor/kernl";
/** tor's default SOCKS5 port. */
export const DEFAULT_SOCKS_PORT = 9050;
/**
 * tor's HTTP CONNECT tunnel. This is what onion traffic actually uses: Bun's
 * fetch rejects a socks5:// proxy outright (UnsupportedProxyProtocol), and
 * tor speaks plain HTTP CONNECT on this port, so no SOCKS client is needed.
 */
export const DEFAULT_HTTP_TUNNEL_PORT = 9080;

export interface TorStatus {
  available: boolean;
  onionUrl: string;
  /** Kept for tools that speak SOCKS directly (curl, other clients). */
  socksProxy: string;
  /** What our own fetch uses. */
  httpProxy: string;
}

export function detectTor(opts: { dataDir?: string; socksPort?: number; httpPort?: number } = {}): TorStatus {
  const socksPort = opts.socksPort ?? Number(process.env.KERNEL_TOR_SOCKS_PORT ?? DEFAULT_SOCKS_PORT);
  const httpPort = opts.httpPort ?? Number(process.env.KERNEL_TOR_HTTP_PORT ?? DEFAULT_HTTP_TUNNEL_PORT);
  const socksProxy = `socks5h://127.0.0.1:${socksPort}`;
  const httpProxy = `http://127.0.0.1:${httpPort}`;

  const dir =
    process.env.KERNEL_TOR_HIDDEN_SERVICE_DIR ??
    resolve(opts.dataDir ?? process.cwd(), DEFAULT_HIDDEN_SERVICE_DIR);
  const hostnameFile = resolve(dir, "hostname");

  if (!existsSync(hostnameFile)) {
    return { available: false, onionUrl: "", socksProxy, httpProxy };
  }
  try {
    const hostname = readFileSync(hostnameFile, "utf-8").trim();
    if (!hostname.endsWith(".onion")) {
      log.warn(`peering: ${hostnameFile} does not look like an onion address`);
      return { available: false, onionUrl: "", socksProxy, httpProxy };
    }
    return { available: true, onionUrl: `http://${hostname}`, socksProxy, httpProxy };
  } catch (err) {
    log.warn(`peering: could not read the onion hostname: ${String(err)}`);
    return { available: false, onionUrl: "", socksProxy, httpProxy };
  }
}

/**
 * Is tor actually accepting connections?
 *
 * The hostname file lives in the data volume and survives forever, so its
 * presence proves only that this instance *once* had an onion. Advertising one
 * while the daemon is off is worse than advertising nothing: every friend then
 * spends a full circuit timeout on an address that cannot answer.
 */
export function isTorListening(
  port: number,
  timeoutMs = 1500,
  host = "127.0.0.1",
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/**
 * A fetch that sends .onion traffic through tor's HTTP CONNECT tunnel and everything
 * else straight out. Bun's fetch takes a per-request `proxy` option; on a
 * runtime without it, onion requests simply fail rather than leaking the
 * hostname to a public resolver.
 */
export function makeTorAwareFetch(
  base: typeof fetch,
  torProxy: string,
): (url: string, init?: RequestInit) => Promise<Response> {
  let proxyHost = "127.0.0.1";
  let proxyPort = DEFAULT_HTTP_TUNNEL_PORT;
  try {
    const parsed = new URL(torProxy);
    proxyHost = parsed.hostname || proxyHost;
    proxyPort = parsed.port ? Number(parsed.port) : proxyPort;
  } catch {
    /* keep the defaults */
  }

  return (url: string, init?: RequestInit) => {
    let isOnion = false;
    try {
      isOnion = new URL(url).hostname.endsWith(".onion");
    } catch {
      isOnion = false;
    }
    if (!isOnion) return base(url, init);
    // Onion traffic never goes through the runtime's fetch: it cannot do the
    // CONNECT handshake tor requires, and a plain request would leak the
    // hostname to the system resolver.
    return onionFetch(url, init, { proxyHost, proxyPort });
  };
}

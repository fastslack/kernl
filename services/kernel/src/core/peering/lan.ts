/**
 * The LAN addresses this instance advertises to friends.
 *
 * A friend on the same network should reach us directly, without relays or
 * onion. What "directly" means depends on how Kernl runs:
 *
 *   - Native install: the process listens on the machine's own interfaces, so
 *     its private IPv4 addresses (and its mDNS name) are the address.
 *   - Docker: the process sees a container hostname and a bridge IP, neither
 *     of which anyone on the LAN can use, and the port it listens on is not
 *     the one the host publishes. Only the operator (or the installer) knows
 *     the host's LAN address, so it comes from KERNEL_LAN_URL. Without it we
 *     advertise no LAN entry rather than a useless one.
 *
 * IPs come first and the `.local` name last: an IP works from inside a
 * container on the other side too, where mDNS does not resolve.
 */
import { existsSync } from "node:fs";
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export interface LanEnv {
  /** Explicit LAN URL(s), comma-separated. Always wins. */
  lanUrl?: string;
  inDocker: boolean;
  hostname: string;
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  port: number;
}

/** Interfaces that are never the LAN: container bridges, VPN tunnels, loopback. */
const VIRTUAL_IFACE = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|wg|tailscale|zt|llw|awdl|bridge|anpi|ap\d)/i;

/** RFC 1918 private ranges — the addresses a home or office LAN hands out. */
export function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

export function lanReachUrls(env: LanEnv): string[] {
  const explicit = (env.lanUrl ?? "")
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (explicit.length) return explicit;
  if (env.inDocker) return [];

  const urls: string[] = [];
  for (const [name, addrs] of Object.entries(env.interfaces)) {
    if (!addrs || VIRTUAL_IFACE.test(name)) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal && isPrivateIPv4(a.address)) {
        urls.push(`http://${a.address}:${env.port}`);
      }
    }
  }
  const host = env.hostname.replace(/\.local$/, "");
  if (host) urls.push(`http://${host}.local:${env.port}`);
  return [...new Set(urls)];
}

/** The real environment, for the service. */
export function currentLanEnv(port: number): LanEnv {
  return {
    lanUrl: process.env.KERNEL_LAN_URL,
    inDocker: existsSync("/.dockerenv") || process.env.KERNEL_IN_DOCKER === "1",
    hostname: hostname(),
    interfaces: networkInterfaces(),
    port,
  };
}

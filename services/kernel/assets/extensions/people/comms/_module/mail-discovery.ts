/**
 * From an email address to the servers that serve it, the way Thunderbird
 * does it: built-in table → the domain's autoconfig → Mozilla's ISPDB → MX
 * records → a guess. The first step that answers wins. Only the domain ever
 * leaves the machine — never the address's local part to the ISPDB, never
 * the password.
 */
import { resolveMx as dnsResolveMx } from "node:dns/promises";
import { providerForDomain, providerForMx, type MailAuth, type ServerEndpoint, type KnownProvider } from "./mail-providers.js";
import { parseAutoconfigXml, httpsFetchText } from "./mail-autoconfig.js";

export const STEP_TIMEOUT_MS = 3000;
export const TOTAL_BUDGET_MS = 8000;
export const CACHE_TTL_MS = 3_600_000;

export type DiscoverySource = "builtin" | "autoconfig" | "ispdb" | "mx" | "guess" | "manual";

export interface Discovery {
  source: DiscoverySource;
  provider: { id: string | null; name: string; auth: MailAuth };
  imap: ServerEndpoint | null;
  smtp: ServerEndpoint | null;
  helpUrl?: string;
}

export interface DiscoveryDeps {
  fetchText?: (url: string, timeoutMs: number) => Promise<string | null>;
  resolveMx?: (domain: string) => Promise<string[]>;
  now?: () => number;
}

const EMAIL_RE = /^[^\s@]+@([a-z0-9-]+\.)+[a-z]{2,}$/;

export function normalizeEmail(raw: string): string | null {
  const e = (raw ?? "").trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

const cache = new Map<string, { at: number; value: Discovery }>();
export function clearDiscoveryCache(): void {
  cache.clear();
}

const fromKnown = (p: KnownProvider, source: DiscoverySource): Discovery => ({
  source,
  provider: { id: p.id, name: p.name, auth: p.auth },
  imap: p.imap ?? null,
  smtp: p.smtp ?? null,
  ...(p.helpUrl ? { helpUrl: p.helpUrl } : {}),
});

async function defaultResolveMx(domain: string): Promise<string[]> {
  const records = await dnsResolveMx(domain);
  return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
}

/** The registrable-looking tail of a host: `mx1.hostinger.com` → `hostinger.com`, `mx.hosting.co.uk` → `hosting.co.uk`. */
export function hostDomain(host: string): string {
  const cleaned = host.replace(/\.$/, "");
  const labels = cleaned.split(".");
  if (labels.length < 2) return cleaned;

  const last = labels[labels.length - 1];
  const secondLast = labels[labels.length - 2];

  // If last is 2-letter ccTLD and second-to-last is a known second-level, keep 3 labels
  const knownSecondLevels = ["com", "net", "org", "gov", "edu", "co", "ac", "gob", "ne", "or"];
  if (last.length === 2 && knownSecondLevels.includes(secondLast) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }

  return labels.slice(-2).join(".");
}

export async function discover(email: string, deps: DiscoveryDeps = {}): Promise<Discovery> {
  const domain = email.split("@")[1];
  const now = deps.now ?? Date.now;

  // Check email-level cache first (for autoconfig results with %EMAILADDRESS% substitution)
  const emailHit = cache.get(email);
  if (emailHit && now() - emailHit.at < CACHE_TTL_MS) return emailHit.value;

  // Then check domain-level cache (for all other sources)
  const domainHit = cache.get(domain);
  if (domainHit && now() - domainHit.at < CACHE_TTL_MS) return domainHit.value;

  const value = await runCascade(email, domain, deps, now);

  // Cache autoconfig results by email (personalisable), others by domain
  const key = value.source === "autoconfig" ? email : domain;
  cache.set(key, { at: now(), value });
  return value;
}

async function runCascade(
  email: string,
  domain: string,
  deps: DiscoveryDeps,
  now: () => number,
): Promise<Discovery> {
  const known = providerForDomain(domain);
  if (known) return fromKnown(known, "builtin");

  const fetchText = deps.fetchText ?? ((url: string, ms: number) => httpsFetchText(url, ms));
  const resolveMx = deps.resolveMx ?? defaultResolveMx;
  const deadline = now() + TOTAL_BUDGET_MS;
  const budget = () => Math.min(STEP_TIMEOUT_MS, deadline - now());

  const fromXml = async (url: string, source: DiscoverySource): Promise<Discovery | null> => {
    const ms = budget();
    if (ms <= 0) return null;
    const xml = await fetchText(url, ms);
    const parsed = xml ? parseAutoconfigXml(xml, email) : null;
    if (!parsed) return null;
    return {
      source,
      provider: { id: null, name: parsed.name ?? domain, auth: "password" },
      imap: parsed.imap,
      smtp: parsed.smtp,
    };
  };

  const ispdb = (d: string) => `https://autoconfig.thunderbird.net/v1.1/${d}`;

  const found =
    (await fromXml(`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`, "autoconfig")) ??
    (await fromXml(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`, "autoconfig")) ??
    (await fromXml(ispdb(domain), "ispdb"));
  if (found) return found;

  const ms = budget();
  if (ms > 0) {
    let timeoutHandle: NodeJS.Timeout | null = null;
    const mx = await Promise.race([
      resolveMx(domain).catch(() => [] as string[]),
      new Promise<string[]>((res) => {
        timeoutHandle = setTimeout(() => res([]), ms);
      }),
    ]);
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);

    if (mx.length > 0) {
      const byMx = providerForMx(mx[0]);
      if (byMx) return fromKnown(byMx, "mx");
      const viaIsp = await fromXml(ispdb(hostDomain(mx[0])), "mx");
      if (viaIsp) return viaIsp;
    }
  }

  return {
    source: "guess",
    provider: { id: null, name: domain, auth: "password" },
    imap: { host: `imap.${domain}`, port: 993, secure: true },
    smtp: { host: `smtp.${domain}`, port: 465, secure: true },
  };
}

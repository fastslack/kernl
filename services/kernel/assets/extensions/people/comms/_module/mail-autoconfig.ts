/**
 * Mozilla's mail autoconfig format (config-v1.1), as served by a domain's
 * own `autoconfig.` host and by the public ISPDB. Only the first IMAP and
 * the first SMTP server that use SSL or STARTTLS are taken; plain-text
 * servers are never offered.
 */
import type { ServerEndpoint } from "./mail-providers.js";

export const AUTOCONFIG_MAX_BYTES = 65_536;

export interface AutoconfigResult {
  name: string | null;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; redirect: "follow" },
) => Promise<{ ok: boolean; url: string; text(): Promise<string> }>;

const tag = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i"));
  return m ? m[1] : null;
};

function firstServer(xml: string, element: string, type: string, email: string): ServerEndpoint | null {
  const [local, domain] = email.split("@");
  const re = new RegExp(`<${element}\\s+type="${type}"\\s*>([\\s\\S]*?)</${element}>`, "gi");
  for (const m of xml.matchAll(re)) {
    const block = m[1];
    const socket = (tag(block, "socketType") ?? "").toUpperCase();
    if (socket !== "SSL" && socket !== "STARTTLS") continue;
    const host = (tag(block, "hostname") ?? "")
      .replace(/%EMAILADDRESS%/g, email)
      .replace(/%EMAILLOCALPART%/g, local)
      .replace(/%EMAILDOMAIN%/g, domain);
    const port = Number(tag(block, "port"));
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) continue;
    return { host, port, secure: socket === "SSL" };
  }
  return null;
}

export function parseAutoconfigXml(xml: string, email: string): AutoconfigResult | null {
  const imap = firstServer(xml, "incomingServer", "imap", email);
  const smtp = firstServer(xml, "outgoingServer", "smtp", email);
  if (!imap || !smtp) return null;
  return { name: tag(xml, "displayName"), imap, smtp };
}

/**
 * GET over https only, following redirects but refusing one that lands on
 * http. Null on any failure: a step of the discovery cascade that does not
 * answer is simply skipped.
 */
export async function httpsFetchText(
  url: string,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string | null> {
  if (!url.startsWith("https://") || timeoutMs <= 0) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await Promise.race([
      fetchImpl(url, { signal: ctrl.signal, redirect: "follow" }),
      new Promise<never>((_, reject) =>
        ctrl.signal.addEventListener("abort", () => reject(new Error("timeout")))),
    ]);
    if (!res.ok || !res.url.startsWith("https://")) return null;
    const body = await res.text();
    return body.length > AUTOCONFIG_MAX_BYTES ? null : body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

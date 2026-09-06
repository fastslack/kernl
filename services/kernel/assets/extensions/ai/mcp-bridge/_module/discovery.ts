/**
 * MCP endpoint discovery — turn a pasted URL into a connection plan.
 *
 * Adding a server used to mean knowing its transport, its auth scheme, its
 * token endpoint and its PKCE method. None of that needs asking: the protocol
 * publishes it. An unauthenticated `initialize` either succeeds — in which case
 * there is nothing to configure — or comes back 401 carrying a pointer to the
 * protected-resource metadata, which names the authorization server, which
 * publishes its own endpoints.
 *
 * So the form asks for one field and derives the rest. Manual entry stays as
 * the fallback for servers that answer 401 without the metadata pointer, which
 * is legal but leaves nothing to discover.
 *
 * Nothing here connects or stores; it reports what it found.
 */

const PROBE_TIMEOUT_MS = 10_000;

export interface DiscoveryOk {
  ok: true;
  transport: "http";
  /** `none` when the endpoint answered without credentials. */
  auth_mode: "none" | "authorization_code";
  /** Human name from the resource metadata, e.g. "Upwork MCP". */
  resource_name: string | null;
  authorize_url: string | null;
  token_url: string | null;
  /** True when the authorization server advertises S256. */
  pkce_s256: boolean;
  scopes_supported: string[] | null;
  /**
   * True when the server needs auth but published no usable metadata, so the
   * operator has to fill the endpoints in by hand.
   */
  manual_required: boolean;
}

export interface DiscoveryErr {
  ok: false;
  /** Safe to show verbatim; never carries a credential. */
  error: string;
}

export type DiscoveryResult = DiscoveryOk | DiscoveryErr;

type FetchLike = typeof fetch;

/** Parses `resource_metadata="…"` out of a WWW-Authenticate header. */
export function parseResourceMetadataUrl(header: string | null): string | null {
  if (!header) return null;
  const quoted = header.match(/resource_metadata\s*=\s*"([^"]+)"/i);
  if (quoted) return quoted[1];
  const bare = header.match(/resource_metadata\s*=\s*([^\s,;]+)/i);
  return bare ? bare[1] : null;
}

/**
 * RFC 8414 puts the authorization server's metadata under a well-known path
 * derived from the issuer, but plenty of servers (Upwork included) also answer
 * the plain `/.well-known/oauth-authorization-server` at the origin. Try both,
 * in spec order.
 */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return [];
  }
  const path = url.pathname.replace(/\/$/, "");
  const origin = url.origin;
  const out = new Set<string>();
  if (path) out.add(`${origin}/.well-known/oauth-authorization-server${path}`);
  out.add(`${origin}/.well-known/oauth-authorization-server`);
  if (path) out.add(`${origin}/.well-known/openid-configuration${path}`);
  out.add(`${origin}/.well-known/openid-configuration`);
  return [...out];
}

/**
 * Each metadata GET gets its own deadline rather than sharing the probe's.
 * A single budget across three sequential requests meant a slow first hop ate
 * the whole allowance and the last fetch aborted — which this function reports
 * as "no metadata", so the endpoint silently degraded to manual entry with
 * nothing in the logs to say why.
 */
async function getJson(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe an MCP HTTP endpoint.
 *
 * `fetchImpl` is injectable so the tests never touch the network.
 */
export async function discoverHttpServer(
  endpoint: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<DiscoveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stepTimeout = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, error: `Not a valid URL: ${endpoint}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Unsupported scheme "${parsed.protocol}" — use http or https.` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS);

  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "kernl-discovery", version: "1.0.0" },
        },
      }),
      signal: controller.signal,
    });

    // Answered without credentials — nothing to configure.
    if (res.ok) {
      return {
        ok: true,
        transport: "http",
        auth_mode: "none",
        resource_name: null,
        authorize_url: null,
        token_url: null,
        pkce_s256: false,
        scopes_supported: null,
        manual_required: false,
      };
    }

    if (res.status !== 401 && res.status !== 403) {
      return { ok: false, error: `The endpoint answered ${res.status} ${res.statusText}.` };
    }

    const unauthenticated: DiscoveryOk = {
      ok: true,
      transport: "http",
      auth_mode: "authorization_code",
      resource_name: null,
      authorize_url: null,
      token_url: null,
      pkce_s256: false,
      scopes_supported: null,
      manual_required: true,
    };

    const metadataUrl = parseResourceMetadataUrl(res.headers.get("www-authenticate"));
    if (!metadataUrl) return unauthenticated;

    const resource = await getJson(metadataUrl, fetchImpl, stepTimeout);
    if (!resource) return unauthenticated;

    const resourceName = typeof resource.resource_name === "string" ? resource.resource_name : null;
    const issuers = Array.isArray(resource.authorization_servers)
      ? (resource.authorization_servers as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    if (issuers.length === 0) return { ...unauthenticated, resource_name: resourceName };

    for (const candidate of authorizationServerMetadataUrls(issuers[0])) {
      const as = await getJson(candidate, fetchImpl, stepTimeout);
      if (!as) continue;
      const authorize = typeof as.authorization_endpoint === "string" ? as.authorization_endpoint : null;
      const token = typeof as.token_endpoint === "string" ? as.token_endpoint : null;
      if (!authorize || !token) continue;

      const methods = Array.isArray(as.code_challenge_methods_supported)
        ? (as.code_challenge_methods_supported as unknown[]).map(String)
        : [];
      const scopes = Array.isArray(as.scopes_supported)
        ? (as.scopes_supported as unknown[]).map(String)
        : null;

      return {
        ok: true,
        transport: "http",
        auth_mode: "authorization_code",
        resource_name: resourceName,
        authorize_url: authorize,
        token_url: token,
        pkce_s256: methods.includes("S256"),
        scopes_supported: scopes,
        manual_required: false,
      };
    }

    return { ...unauthenticated, resource_name: resourceName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // AbortError reads as nothing useful to an operator; name the real problem.
    if (/abort/i.test(msg)) return { ok: false, error: "The endpoint did not answer in time." };
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

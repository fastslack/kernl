/**
 * A project's own Google account (Analytics and Search Console, read-only), linked by
 * Google's consent screen instead of pasted keys. It rides on the Google OAuth client
 * Kernl already has and on its registered redirect (/auth/google/callback): the OAuth
 * `state` carries the project, and google-sync's callback hands such a code back here.
 */
import { randomBytes } from "node:crypto";

export const GOOGLE_PROJECT_SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];

export interface GoogleClient { clientId: string; clientSecret: string; redirectUri: string }

let client: () => GoogleClient | null = () => null;
/** Set once at startup: the credentials are read at call time, so saving them in Ajustes applies without a restart. */
export function configureGoogleClient(get: () => GoogleClient | null): void { client = get; }
export function googleClient(): GoogleClient {
  const c = client();
  if (!c?.clientId || !c.clientSecret) throw new Error("Kernl no tiene el cliente de Google configurado (Ajustes → IA → Google: Client ID y Client secret)");
  return c;
}

const TTL = 15 * 60_000;
const pending = new Map<string, { projectId: string; at: number }>();

/** The consent URL for a project. `returnTo` is where the browser lands afterwards (google-sync validates it). */
export function googleConsentUrl(projectId: string, returnTo: string, now = Date.now()): string {
  const c = googleClient();
  for (const [k, v] of pending) if (now - v.at > TTL) pending.delete(k);
  const nonce = randomBytes(16).toString("base64url");
  pending.set(nonce, { projectId, at: now });
  const state = Buffer.from(JSON.stringify({ r: returnTo, p: projectId, n: nonce })).toString("base64url");
  const q = new URLSearchParams({
    client_id: c.clientId, redirect_uri: c.redirectUri, response_type: "code", scope: GOOGLE_PROJECT_SCOPES.join(" "),
    access_type: "offline", prompt: "consent select_account", state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** The project a callback `state` was issued for (one use), or null when it is not ours or expired. */
export function claimState(state: string | null, now = Date.now()): string | null {
  if (!state) return null;
  let s: { p?: unknown; n?: unknown };
  try { s = JSON.parse(Buffer.from(state, "base64url").toString("utf8")); } catch { return null; }
  if (typeof s.p !== "string" || typeof s.n !== "string") return null;
  const hit = pending.get(s.n);
  pending.delete(s.n);
  return hit && hit.projectId === s.p && now - hit.at <= TTL ? s.p : null;
}

/** Whether a callback `state` belongs to a project link (so google-sync must not treat it as its own). */
export function isProjectState(state: string | null): boolean {
  if (!state) return false;
  try { return typeof (JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as { p?: unknown }).p === "string"; } catch { return false; }
}

async function tokenCall(body: Record<string, string>, fetchFn: typeof fetch): Promise<{ access_token: string; refresh_token?: string; id_token?: string; expires_in?: number }> {
  const res = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || !j.access_token) throw new Error(`Google rechazó el pedido (${j.error_description || j.error || `HTTP ${res.status}`})`);
  return j as unknown as { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number };
}

/** Code → refresh token and the email of the Google account that consented. */
export async function exchangeCode(code: string, fetchFn: typeof fetch): Promise<{ refreshToken: string; email: string }> {
  const c = googleClient();
  const t = await tokenCall({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: "authorization_code" }, fetchFn);
  if (!t.refresh_token) throw new Error("Google no devolvió un permiso duradero: volvé a conectar y aceptá todos los permisos");
  let email = "";
  try { email = String((JSON.parse(Buffer.from((t.id_token ?? "").split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string }).email ?? ""); } catch { /* shown as the account without email */ }
  return { refreshToken: t.refresh_token, email };
}

const cache = new Map<string, { token: string; until: number }>();
/** A short-lived access token for a stored refresh token (cached until a minute before it expires). */
export async function googleAccessToken(refreshToken: string, fetchFn: typeof fetch, now = Date.now()): Promise<string> {
  const hit = cache.get(refreshToken);
  if (hit && hit.until > now) return hit.token;
  const c = googleClient();
  const t = await tokenCall({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token" }, fetchFn);
  cache.set(refreshToken, { token: t.access_token, until: now + Math.max(0, (t.expires_in ?? 3600) - 60) * 1000 });
  return t.access_token;
}

export interface GoogleOptions {
  email: string;
  properties: Array<{ id: string; name: string; account: string }>;
  sites: Array<{ url: string; permission: string }>;
  /** Why a list could not be read (an API not enabled in the Google Cloud project, no access…). */
  problems: string[];
}

/** What the linked account can see: its GA4 properties and its Search Console sites, to pick from. */
export async function googleOptions(refreshToken: string, email: string, fetchFn: typeof fetch): Promise<GoogleOptions> {
  const token = await googleAccessToken(refreshToken, fetchFn);
  const h = { Authorization: `Bearer ${token}` };
  const problems: string[] = [];
  const properties: GoogleOptions["properties"] = [];
  let page = "";
  for (let i = 0; i < 10; i++) {
    const res = await fetchFn(`https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, { headers: h, signal: AbortSignal.timeout(15_000) });
    const j = (await res.json().catch(() => ({}))) as { accountSummaries?: Array<{ displayName?: string; propertySummaries?: Array<{ property?: string; displayName?: string }> }>; nextPageToken?: string; error?: { message?: string } };
    if (!res.ok) { problems.push(apiProblem("Google Analytics", res.status, j.error?.message ?? "", "analyticsadmin.googleapis.com")); break; }
    for (const a of j.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) {
      const id = (p.property ?? "").replace(/^properties\//, "");
      if (id) properties.push({ id, name: p.displayName ?? id, account: a.displayName ?? "" });
    }
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  const res = await fetchFn("https://www.googleapis.com/webmasters/v3/sites", { headers: h, signal: AbortSignal.timeout(15_000) });
  const j = (await res.json().catch(() => ({}))) as { siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }>; error?: { message?: string } };
  const sites = res.ok ? (j.siteEntry ?? []).filter((s) => s.siteUrl && s.permissionLevel !== "siteUnverifiedUser").map((s) => ({ url: s.siteUrl!, permission: s.permissionLevel ?? "" })) : [];
  if (!res.ok) problems.push(apiProblem("Search Console", res.status, j.error?.message ?? "", "searchconsole.googleapis.com"));
  return { email, properties, sites, problems };
}

function apiProblem(what: string, status: number, message: string, api: string): string {
  if (status === 403 && /has not been used|is disabled|not enabled/i.test(message)) {
    const project = /project[= ]+(\d+)/i.exec(message)?.[1];
    return `${what}: la API ${api} está apagada en el proyecto de Google Cloud de Kernl. Activala en https://console.cloud.google.com/apis/library/${api}${project ? `?project=${project}` : ""} y volvé a abrir esto.`;
  }
  return `${what}: Google respondió HTTP ${status}${message ? ` (${message.slice(0, 160)})` : ""}`;
}

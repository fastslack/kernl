/**
 * A project's own accounts on the services it deploys to and reads from:
 * Cloudflare, Datadog, AWS, Google (Analytics and Search Console, linked by
 * consent in google-link.ts), and the git identity its commits and pushes go out
 * as. One per service and project; an account belongs to its project only, so
 * a deploy or a read for one project never goes out as another (03/11: the
 * Kernl site's wrangler deploy kept landing in the wrong Cloudflare account).
 *
 * The secrets are sealed with the kernel key; listings show only which secret
 * fields are set and their last four characters. An account is tested against
 * its service before it is saved, and the test says who it authenticated as.
 */

import { createHash, createHmac } from "node:crypto";
import { encrypt, decrypt } from "../../sdk/crypto.js";
import { newId, isoNow } from "../../core/helpers.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { googleAccessToken } from "./google-link.js";

export const ACCOUNT_PROVIDERS = ["cloudflare", "datadog", "aws", "git", "env", "google"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export interface AccountValues {
  /** Not secret: account id, region, site, author name… */
  config: Record<string, string>;
  /** Sealed at rest: tokens, keys. */
  secrets: Record<string, string>;
}

export interface ProjectAccount extends AccountValues {
  id: string;
  project_id: string;
  provider: AccountProvider;
  /** Who the last test authenticated as ("acme-bot", "arn:aws:iam::…:user/deploy"). */
  identity: string;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string;
  created_at: string;
  updated_at: string;
}

/** What the dashboard and the tools see: secrets reduced to "…abcd". */
export interface PublicAccount extends Omit<ProjectAccount, "secrets"> {
  secrets: Record<string, string>;
}

interface FieldSpec { key: string; secret: boolean; required: boolean }

interface ProviderSpec {
  fields: FieldSpec[];
  /** Reads the form itself when its fields are not a fixed list (the custom environment). */
  readInput?: (input: Record<string, unknown>, previous?: AccountValues) => AccountValues;
  normalize?: (v: AccountValues) => AccountValues;
  validate?: (v: AccountValues) => string | null;
  /**
   * One authenticated round-trip; resolves to who it is, throws with the service's reason.
   * It may correct `v.config` from what the service says (Datadog's region, found from the key).
   */
  test: (v: AccountValues, fetchFn: typeof fetch) => Promise<string>;
  /** The variables a deploy command gets. */
  env: (v: AccountValues) => Record<string, string>;
}

export const DATADOG_SITES = new Set([
  "datadoghq.com", "us3.datadoghq.com", "us5.datadoghq.com", "datadoghq.eu", "uk1.datadoghq.com",
  "ap1.datadoghq.com", "ap2.datadoghq.com", "ddog-gov.com", "us2.ddog-gov.com",
]);

const ddHeaders = (apiKey: string, appKey?: string): Record<string, string> => ({
  "DD-API-KEY": apiKey, Accept: "application/json", ...(appKey ? { "DD-APPLICATION-KEY": appKey, "Content-Type": "application/json" } : {}),
});

/** Whether Datadog takes this API key on that site (a key only works on the region it was made in). */
async function ddKeyValid(site: string, apiKey: string, fetchFn: typeof fetch): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchFn(`https://api.${site}/api/v1/validate`, { headers: ddHeaders(apiKey), signal: AbortSignal.timeout(TIMEOUT) });
    return { ok: res.ok && (await json(res)).valid === true, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** `datadoghq.eu`, `us5.datadoghq.com`, or a pasted `https://app.datadoghq.eu/...` → the bare site. */
export function datadogSite(site: string): string {
  return (site || "datadoghq.com").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0].replace(/^(api|app)\./, "");
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function cfErrors(body: Record<string, unknown>): string {
  const errs = Array.isArray(body.errors) ? (body.errors as Array<{ message?: string }>).map((e) => e.message).filter(Boolean) : [];
  return errs.join("; ");
}

// ── AWS SigV4, just enough for STS GetCallerIdentity ───────────────
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** A signed STS GetCallerIdentity request (exported for its test). */
export function signedCallerIdentity(accessKeyId: string, secret: string, region: string, now = new Date()): { url: string; init: RequestInit } {
  const host = `sts.${region}.amazonaws.com`;
  const body = "Action=GetCallerIdentity&Version=2011-06-15";
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const contentType = "application/x-www-form-urlencoded; charset=utf-8";
  const signedHeaders = "content-type;host;x-amz-date";
  const canonical = ["POST", "/", "", `content-type:${contentType}`, `host:${host}`, `x-amz-date:${amzDate}`, "", signedHeaders, sha256(body)].join("\n");
  const scope = `${day}/${region}/sts/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), "sts"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return {
    url: `https://${host}/`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "X-Amz-Date": amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body,
    },
  };
}

const TIMEOUT = 15_000;

export const PROVIDERS: Record<AccountProvider, ProviderSpec> = {
  cloudflare: {
    fields: [
      { key: "account_id", secret: false, required: true },
      { key: "api_token", secret: true, required: true },
    ],
    validate: (v) => (/^[0-9a-f]{32}$/i.test(v.config.account_id) ? null : "account_id: son 32 caracteres hexadecimales (Cloudflare → la cuenta → Account ID)"),
    test: async (v, fetchFn) => {
      const api = "https://api.cloudflare.com/client/v4";
      const headers = { Authorization: `Bearer ${v.secrets.api_token}` };
      const res = await fetchFn(`${api}/accounts/${v.config.account_id}`, { headers, signal: AbortSignal.timeout(TIMEOUT) });
      const body = await json(res);
      if (!res.ok || body.success === false) {
        throw new Error(`Cloudflare no dejó entrar a la cuenta ${v.config.account_id} (HTTP ${res.status}${cfErrors(body) ? `: ${cfErrors(body)}` : ""})`);
      }
      const name = (body.result as { name?: string } | undefined)?.name ?? v.config.account_id;
      return `cuenta ${name}`;
    },
    env: (v) => ({ CLOUDFLARE_API_TOKEN: v.secrets.api_token, CLOUDFLARE_ACCOUNT_ID: v.config.account_id }),
  },
  datadog: {
    fields: [
      { key: "site", secret: false, required: false },
      { key: "api_key", secret: true, required: true },
      { key: "app_key", secret: true, required: false },
    ],
    normalize: (v) => ({ ...v, config: { ...v.config, site: datadogSite(v.config.site ?? "") } }),
    validate: (v) => (DATADOG_SITES.has(v.config.site) ? null : `site: "${v.config.site}" no es una región de Datadog (${[...DATADOG_SITES].join(", ")})`),
    test: async (v, fetchFn) => {
      const chosen = v.config.site;
      const first = await ddKeyValid(chosen, v.secrets.api_key, fetchFn);
      if (!first.ok) {
        // Picking the wrong region is the usual slip: ask every other region before calling the key bad.
        const others = [...DATADOG_SITES].filter((s) => s !== chosen);
        const found = (await Promise.all(others.map(async (s) => ((await ddKeyValid(s, v.secrets.api_key, fetchFn)).ok ? s : "")))).find(Boolean);
        if (!found) throw new Error(`Datadog rechazó la API key en todas sus regiones (HTTP ${first.status} en ${chosen}): copiala de nuevo desde Organization Settings → API Keys`);
        v.config.site = found;
      }
      const parts = [`API key válida en ${v.config.site}${v.config.site !== chosen ? " (región detectada)" : ""}`];
      if (v.secrets.app_key) {
        // The one read Kernl makes with it: live RUM sessions, for Growth's Plaza.
        const res = await fetchFn(`https://api.${v.config.site}/api/v2/rum/events/search`, {
          method: "POST", headers: ddHeaders(v.secrets.api_key, v.secrets.app_key), signal: AbortSignal.timeout(TIMEOUT),
          body: JSON.stringify({ filter: { query: "*", from: "now-15m", to: "now" }, page: { limit: 1 } }),
        });
        if (res.status === 401) throw new Error("Datadog rechazó la application key: copiala de nuevo (se muestra una sola vez al crearla)");
        if (res.status === 403) throw new Error("La application key no puede leer RUM: editala en Datadog y sumale el scope rum_apps_read");
        if (!res.ok) throw new Error(`Datadog no dejó leer RUM con la application key (HTTP ${res.status})`);
        parts.push("lee RUM");
      }
      return parts.join(" · ");
    },
    env: (v) => ({
      DD_API_KEY: v.secrets.api_key,
      DD_SITE: v.config.site,
      ...(v.secrets.app_key ? { DD_APP_KEY: v.secrets.app_key } : {}),
    }),
  },
  aws: {
    fields: [
      { key: "region", secret: false, required: true },
      { key: "access_key_id", secret: false, required: true },
      { key: "secret_access_key", secret: true, required: true },
    ],
    validate: (v) => {
      if (!/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(v.config.region)) return `region: "${v.config.region}" no es una región de AWS (ej.: eu-west-1)`;
      if (!/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(v.config.access_key_id)) return "access_key_id: tiene que empezar con AKIA y tener 20 caracteres";
      return null;
    },
    test: async (v, fetchFn) => {
      const { url, init } = signedCallerIdentity(v.config.access_key_id, v.secrets.secret_access_key, v.config.region);
      const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
      const text = await res.text().catch(() => "");
      const arn = /<Arn>([^<]+)<\/Arn>/.exec(text)?.[1];
      if (!res.ok || !arn) {
        const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
        throw new Error(`AWS rechazó la clave (HTTP ${res.status}${msg ? `: ${msg}` : ""})`);
      }
      return arn;
    },
    env: (v) => ({
      AWS_ACCESS_KEY_ID: v.config.access_key_id,
      AWS_SECRET_ACCESS_KEY: v.secrets.secret_access_key,
      AWS_REGION: v.config.region,
      AWS_DEFAULT_REGION: v.config.region,
    }),
  },
  git: {
    fields: [
      { key: "name", secret: false, required: true },
      { key: "email", secret: false, required: true },
      { key: "ssh_private_key", secret: true, required: false },
    ],
    normalize: (v) => ({ ...v, secrets: v.secrets.ssh_private_key ? { ...v.secrets, ssh_private_key: `${v.secrets.ssh_private_key.trim()}\n` } : v.secrets }),
    validate: (v) => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.config.email)) return `email: "${v.config.email}" no es un email`;
      const k = v.secrets.ssh_private_key ?? "";
      if (k && !/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----\s*$/.test(k)) {
        return "ssh_private_key: pegá la clave privada completa, con las líneas BEGIN y END";
      }
      if (/ENCRYPTED|Proc-Type: 4,ENCRYPTED/.test(k)) return "ssh_private_key: la clave tiene passphrase; un deploy no puede escribirla. Usá una clave de deploy sin passphrase.";
      return null;
    },
    // Nothing to log into: the author and the key are checked when a push uses them.
    test: async (v) => `${v.config.name} <${v.config.email}>${v.secrets.ssh_private_key ? " con clave SSH" : ""}`,
    env: (v) => ({
      GIT_AUTHOR_NAME: v.config.name,
      GIT_AUTHOR_EMAIL: v.config.email,
      GIT_COMMITTER_NAME: v.config.name,
      GIT_COMMITTER_EMAIL: v.config.email,
    }),
  },
  // Whatever else the project's deploy needs, for any service Kernl has no card for (Vercel, Fly, GCP…):
  // variables with any name, all sealed, plus an optional image of its own to deploy from.
  env: {
    fields: [],
    readInput: (input, previous) => {
      const raw = Array.isArray(input.variables)
        ? (input.variables as Array<{ name?: unknown; value?: unknown }>).map((x) => [String(x?.name ?? ""), String(x?.value ?? "")] as const)
        : Object.entries((input.variables ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")] as const);
      const secrets: Record<string, string> = {};
      for (const [n, val] of raw) {
        const name = n.trim();
        if (!name) continue;
        // A value left blank on an edit keeps the stored one (the form never shows it).
        const value = val.trim() || previous?.secrets[name] || "";
        if (!value) throw new Error(`${name}: falta el valor`);
        secrets[name] = value;
      }
      const image = typeof input.image === "string" ? input.image.trim() : "";
      const config: Record<string, string> = image ? { image } : {};
      return { config, secrets };
    },
    validate: (v) => {
      for (const [name, value] of Object.entries(v.secrets)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return `${name}: un nombre de variable va en mayúsculas, números y _ (ej.: VERCEL_TOKEN)`;
        if (/^DEPLOY_/.test(name) || ["HOME", "PATH", "PWD", "SHELL", "USER", "HOSTNAME"].includes(name)) return `${name}: ese nombre lo usa el deploy, elegí otro`;
        if (/[\r\n]/.test(value)) return `${name}: el valor tiene que ir en una sola línea`;
      }
      const image = v.config.image ?? "";
      if (image && !/^[a-z0-9][a-z0-9._\/:@-]{0,254}$/.test(image)) return `image: "${image}" no es una imagen de Docker (ej.: node:22, ghcr.io/acme/deploy:1)`;
      if (!image && Object.keys(v.secrets).length === 0) return "Cargá al menos una variable o una imagen";
      return null;
    },
    // Nothing to log into: the variables are whatever the project's own tools read.
    test: async (v) => {
      const n = Object.keys(v.secrets).length;
      return [n ? `${n} variable${n === 1 ? "" : "s"}` : "", v.config.image ? `imagen ${v.config.image}` : ""].filter(Boolean).join(", ");
    },
    env: (v) => ({ ...v.secrets }),
  },
  google: {
    // The refresh token only ever comes from the consent screen (linkGoogle); the form picks what to read.
    fields: [],
    readInput: (input, previous) => {
      const refresh = previous?.secrets.refresh_token ?? "";
      if (!refresh) throw new Error("Primero conectá la cuenta de Google con el botón «Conectar con Google»");
      const text = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
      const sites = (Array.isArray(input.search_console_sites) ? input.search_console_sites.map(String) : text("search_console_sites").split(","))
        .map((x) => x.trim()).filter(Boolean);
      const config: Record<string, string> = { email: previous?.config.email ?? "" };
      const property = text("ga4_property").replace(/^properties\//, "");
      if (property) { config.ga4_property = property; config.ga4_name = text("ga4_name") || property; }
      if (sites.length) config.search_console_sites = [...new Set(sites)].join(",");
      return { config, secrets: { refresh_token: refresh } };
    },
    validate: (v) => (v.config.ga4_property && !/^\d+$/.test(v.config.ga4_property) ? `ga4_property: "${v.config.ga4_property}" no es una propiedad de GA4 (es un número, no el G-…)` : null),
    test: async (v, fetchFn) => {
      const token = await googleAccessToken(v.secrets.refresh_token, fetchFn);
      const h = { Authorization: `Bearer ${token}` };
      const who = v.config.email || "cuenta de Google";
      const parts = [who];
      if (v.config.ga4_property) {
        const res = await fetchFn(`https://analyticsdata.googleapis.com/v1beta/properties/${v.config.ga4_property}/metadata`, { headers: h, signal: AbortSignal.timeout(TIMEOUT) });
        if (!res.ok) throw new Error(`${who} no puede leer la propiedad de GA4 ${v.config.ga4_name ?? v.config.ga4_property} (HTTP ${res.status})`);
        parts.push(`GA4 ${v.config.ga4_name ?? v.config.ga4_property}`);
      }
      const sites = (v.config.search_console_sites ?? "").split(",").filter(Boolean);
      for (const site of sites) {
        const res = await fetchFn(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}`, { headers: h, signal: AbortSignal.timeout(TIMEOUT) });
        if (!res.ok) throw new Error(`${who} no tiene acceso a ${site} en Search Console (HTTP ${res.status})`);
      }
      if (sites.length) parts.push(`Search Console: ${sites.length === 1 ? sites[0] : `${sites.length} sitios`}`);
      return parts.join(" · ");
    },
    // Reads only: nothing of it goes into a deploy's environment.
    env: () => ({}),
  },
};

interface Row {
  id: string; project_id: string; provider: AccountProvider; config: string; secrets: string; identity: string;
  last_test_at: string | null; last_test_ok: number | null; last_test_error: string; created_at: string; updated_at: string;
}

const mask = (s: string) => (s.length > 8 ? `…${s.slice(-4)}` : "…");

export class ProjectAccountsService {
  constructor(private db: SqliteDb, private key: string, private fetchFn: typeof fetch = fetch) {}

  /** Field values out of a form: trimmed strings, known fields only, required ones present. */
  private read(provider: AccountProvider, input: Record<string, unknown>, previous?: AccountValues): AccountValues {
    const spec = PROVIDERS[provider];
    const out: AccountValues = spec.readInput ? spec.readInput(input, previous) : { config: {}, secrets: {} };
    for (const f of spec.fields) {
      const raw = typeof input[f.key] === "string" ? (input[f.key] as string).trim() : "";
      // A secret left blank on an edit keeps the stored one (the form never shows it).
      const value = raw || (f.secret ? previous?.secrets[f.key] ?? "" : "");
      if (f.required && !value) throw new Error(`${f.key} es obligatorio`);
      if (value) (f.secret ? out.secrets : out.config)[f.key] = value;
    }
    const v = spec.normalize ? spec.normalize(out) : out;
    const problem = spec.validate?.(v);
    if (problem) throw new Error(problem);
    return v;
  }

  private row(projectId: string, provider: AccountProvider): Row | undefined {
    return this.db.prepare("SELECT * FROM project_accounts WHERE project_id = ? AND provider = ?").get(projectId, provider) as Row | undefined;
  }

  private open(r: Row): ProjectAccount {
    return {
      id: r.id, project_id: r.project_id, provider: r.provider, identity: r.identity,
      config: JSON.parse(r.config || "{}"),
      secrets: r.secrets ? JSON.parse(decrypt(r.secrets, this.key)) : {},
      last_test_at: r.last_test_at, last_test_ok: r.last_test_ok == null ? null : r.last_test_ok === 1,
      last_test_error: r.last_test_error, created_at: r.created_at, updated_at: r.updated_at,
    };
  }

  get(projectId: string, provider: AccountProvider): ProjectAccount | null {
    const r = this.row(projectId, provider);
    return r ? this.open(r) : null;
  }

  list(projectId: string): PublicAccount[] {
    const rows = this.db.prepare("SELECT * FROM project_accounts WHERE project_id = ? ORDER BY provider").all(projectId) as Row[];
    return rows.map((r) => {
      const a = this.open(r);
      return { ...a, secrets: Object.fromEntries(Object.entries(a.secrets).map(([k, v]) => [k, mask(v)])) };
    });
  }

  /**
   * Test the values against the service, then save them (replacing the project's account for that service).
   * A refused account is never saved: the stored one, if any, stays as it was.
   */
  async set(projectId: string, provider: AccountProvider, input: Record<string, unknown>): Promise<PublicAccount> {
    const prev = this.get(projectId, provider) ?? undefined;
    const v = this.read(provider, input, prev);
    const identity = await PROVIDERS[provider].test(v, this.fetchFn);
    const now = isoNow();
    const sealed = Object.keys(v.secrets).length ? encrypt(JSON.stringify(v.secrets), this.key) : "";
    this.db.prepare(
      `INSERT INTO project_accounts (id, project_id, provider, config, secrets, identity, last_test_at, last_test_ok, last_test_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, '', ?, ?)
       ON CONFLICT(project_id, provider) DO UPDATE SET config = excluded.config, secrets = excluded.secrets, identity = excluded.identity,
         last_test_at = excluded.last_test_at, last_test_ok = 1, last_test_error = '', updated_at = excluded.updated_at`,
    ).run(prev?.id ?? newId(), projectId, provider, JSON.stringify(v.config), sealed, identity, now, now, now);
    return this.list(projectId).find((a) => a.provider === provider)!;
  }

  /**
   * The consent screen came back with a refresh token: keep it (and the choices already made, when it
   * is the same Google account), sealed. Not tested here: the screen that follows lists what it can see.
   */
  linkGoogle(projectId: string, refreshToken: string, email: string): PublicAccount {
    const prev = this.get(projectId, "google");
    const keep = prev && prev.config.email === email ? prev.config : {};
    const config = { ...keep, email };
    const now = isoNow();
    this.db.prepare(
      `INSERT INTO project_accounts (id, project_id, provider, config, secrets, identity, last_test_at, last_test_ok, last_test_error, created_at, updated_at)
       VALUES (?, ?, 'google', ?, ?, ?, ?, 1, '', ?, ?)
       ON CONFLICT(project_id, provider) DO UPDATE SET config = excluded.config, secrets = excluded.secrets, identity = excluded.identity,
         last_test_at = excluded.last_test_at, last_test_ok = 1, last_test_error = '', updated_at = excluded.updated_at`,
    ).run(prev?.id ?? newId(), projectId, JSON.stringify(config), encrypt(JSON.stringify({ refresh_token: refreshToken }), this.key), email, now, now, now);
    return this.list(projectId).find((a) => a.provider === "google")!;
  }

  /** Re-test the stored account (a token may have expired or lost its access). */
  async test(projectId: string, provider: AccountProvider): Promise<{ ok: boolean; detail: string }> {
    const a = this.get(projectId, provider);
    if (!a) return { ok: false, detail: "No hay cuenta cargada" };
    let ok = true;
    let detail: string;
    try { detail = await PROVIDERS[provider].test(a, this.fetchFn); } catch (err) { ok = false; detail = err instanceof Error ? err.message : String(err); }
    this.db.prepare("UPDATE project_accounts SET last_test_at = ?, last_test_ok = ?, last_test_error = ?, identity = CASE WHEN ? THEN ? ELSE identity END WHERE id = ?")
      .run(isoNow(), ok ? 1 : 0, ok ? "" : detail.slice(0, 1000), ok ? 1 : 0, detail, a.id);
    return { ok, detail };
  }

  remove(projectId: string, provider: AccountProvider): boolean {
    return this.db.prepare("DELETE FROM project_accounts WHERE project_id = ? AND provider = ?").run(projectId, provider).changes > 0;
  }

  /** The environment a deploy for this project runs with: every account it has, and nothing from any other project. */
  env(projectId: string): Record<string, string> {
    // The custom environment last: a variable named there on purpose wins over a card's.
    const rows = (this.db.prepare("SELECT * FROM project_accounts WHERE project_id = ?").all(projectId) as Row[])
      .sort((a, b) => Number(a.provider === "env") - Number(b.provider === "env"));
    return Object.assign({}, ...rows.map((r) => PROVIDERS[r.provider].env(this.open(r))));
  }
}

/** `git@github.com:o/r.git`, `https://github.com/o/r` → `github.com/o/r` (lower case); null when it is not a remote. */
function remoteKey(remote: string): string | null {
  const s = remote.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(s);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const u = new URL(s);
    if (!/^(https?|ssh|git):$/.test(u.protocol)) return null;
    return `${u.hostname}/${u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The project a repo belongs to, from its registered path or its remote: the registered repos linked to a
 * project. Undefined when no project has it, or when several do (then no single identity is right).
 */
export function projectOfRepo(db: SqliteDb, pathOrRemote: string): string | undefined {
  let rows: Array<{ project_id: string; path: string; remote_url: string }>;
  try {
    rows = db.prepare(`SELECT l.project_id, r.path, r.remote_url FROM project_links l JOIN repos r ON r.id = l.ref_id
      WHERE l.kind = 'repo' AND r.deleted_at IS NULL`).all() as typeof rows;
  } catch {
    return undefined;
  }
  const want = pathOrRemote.trim().replace(/\/+$/, "");
  const key = remoteKey(want);
  const owners = new Set(rows.filter((r) => r.path.replace(/\/+$/, "") === want || (key !== null && r.remote_url && remoteKey(r.remote_url) === key)).map((r) => r.project_id));
  return owners.size === 1 ? [...owners][0] : undefined;
}

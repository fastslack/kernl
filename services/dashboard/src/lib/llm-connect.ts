/**
 * Client side of "Connect your AI": the kernel's provider catalog, the
 * test/connect/detect calls, and the pure helpers the wizard and Settings share.
 * Error codes come from the kernel; the sentence and the way out are chosen
 * here so both screens say the same thing.
 */

import { modelIds } from "./llm-models.js";

export type ErrorCode = "auth" | "quota" | "model" | "timeout" | "no_tools" | "unreachable" | "no_session" | "network" | "unknown";
export type Group = "free" | "local" | "paid" | "subscription";
export interface Localized { es: string; en: string }

export interface CatalogProvider {
  slug: string;
  name: string;
  group: Group;
  recommended: boolean;
  kind: string;
  needsKey: boolean;
  keyUrl: string;
  keyHint: string;
  logo: string;
  blurb: Localized;
  tag: Localized;
  pricing: Localized;
  steps: { es: string[]; en: string[] };
  models: { recommended?: string; fast?: string; candidates?: string[] };
  baseUrlEditable: boolean;
  regions: Array<{ id: string; label: Localized; baseUrl: string }>;
  docsUrl: string;
  connected: boolean;
  model: string;
  keyMasked: string;
  baseUrl: string;
  region: string;
  lastTest: { at: string; ok: boolean; latencyMs: number; code?: ErrorCode } | null;
}

export interface ChainLink { provider: string; model: string }

export interface CatalogResponse {
  providers: CatalogProvider[];
  chain: ChainLink[];
  claudeCodeTransition: "cli" | "legacy-token" | "none";
  claudeCodeLoginCommand: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  toolCall: boolean;
  error?: { code: ErrorCode; detail: string };
  switchedModel?: string;
  chain?: ChainLink[];
}

export interface DetectResult { found: boolean; baseUrl: string; models: string[]; session?: boolean; chain?: ChainLink[] }
export interface ConnectInput { apiKey?: string; baseUrl?: string; model?: string; region?: string }

export type ErrorAction = "open_key" | "retry" | "fast_model" | "pick_model" | "copy_command" | "redetect" | "add_backup";
export interface ErrorView { messageKey: string; actionKey?: string; action?: ErrorAction }

export const GROUP_ORDER: Group[] = ["free", "local", "paid", "subscription"];

export function groupProviders(list: CatalogProvider[]): Array<{ group: Group; providers: CatalogProvider[] }> {
  return GROUP_ORDER
    .map((group) => ({ group, providers: list.filter((p) => p.group === group) }))
    .filter((g) => g.providers.length > 0);
}

export function pick(l: Localized, locale: string): string {
  return locale === "es" ? l.es : l.en;
}

/** A soft warning only: several providers' key formats are not documented. */
export function keyLooksWrong(p: CatalogProvider, key: string): boolean {
  const k = key.trim();
  if (!p.keyHint || !k) return false;
  try {
    return !new RegExp(p.keyHint).test(k);
  } catch {
    return false;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const ERROR_VIEWS: Record<ErrorCode, ErrorView> = {
  auth: { messageKey: "llm.err.auth", actionKey: "llm.err.auth_action", action: "open_key" },
  quota: { messageKey: "llm.err.quota", actionKey: "llm.err.quota_action", action: "add_backup" },
  model: { messageKey: "llm.err.model", actionKey: "llm.err.no_tools_action", action: "pick_model" },
  timeout: { messageKey: "llm.err.timeout", actionKey: "llm.err.timeout_action", action: "fast_model" },
  no_tools: { messageKey: "llm.err.no_tools", actionKey: "llm.err.no_tools_action", action: "pick_model" },
  unreachable: { messageKey: "llm.err.unreachable", actionKey: "llm.redetect", action: "redetect" },
  no_session: { messageKey: "llm.err.no_session", actionKey: "llm.copy_command", action: "copy_command" },
  network: { messageKey: "llm.err.network", actionKey: "llm.retry", action: "retry" },
  unknown: { messageKey: "llm.err.unknown", actionKey: "llm.retry", action: "retry" },
};

export function errorView(code: ErrorCode | undefined): ErrorView {
  return ERROR_VIEWS[code ?? "unknown"] ?? ERROR_VIEWS.unknown;
}

export function modelOptions(
  p: CatalogProvider,
  live: string[] = [],
): Array<{ value: string; kind: "recommended" | "fast" | "candidate" | "current" | "other" }> {
  const out: Array<{ value: string; kind: "recommended" | "fast" | "candidate" | "current" | "other" }> = [];
  const add = (value: string | undefined, kind: (typeof out)[number]["kind"]) => {
    if (value && !out.some((o) => o.value === value)) out.push({ value, kind });
  };
  add(p.models.recommended, "recommended");
  add(p.models.fast, "fast");
  for (const c of p.models.candidates ?? []) add(c, "candidate");
  add(p.model, "current");
  for (const m of live) add(m, "other");
  return out;
}

export function chainSummary(chain: ChainLink[], providers: CatalogProvider[]) {
  const view = (l: ChainLink) => {
    const p = providers.find((x) => x.slug === l.provider);
    return { slug: l.provider, name: p?.name ?? l.provider, model: l.model || p?.model || "" };
  };
  const [first, ...rest] = chain;
  return { primary: first ? view(first) : null, fallbacks: rest.map(view) };
}

export function timeAgo(iso: string, now = Date.now()): { key: string; n: number } {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return { key: "llm.ago_now", n: 0 };
  if (s < 3600) return { key: "llm.ago_min", n: Math.round(s / 60) };
  if (s < 86400) return { key: "llm.ago_hour", n: Math.round(s / 3600) };
  return { key: "llm.ago_day", n: Math.round(s / 86400) };
}

// ── HTTP ────────────────────────────────────────────────────────────────
// Raw fetch: the root layout adds the auth header to every /api call.

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body as T;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const providerUrl = (slug: string, tail: string) => `/api/llm-providers/${encodeURIComponent(slug)}/${tail}`;

export const fetchCatalog = () => call<CatalogResponse>("/api/llm/catalog");
export const testProvider = (slug: string, input: ConnectInput = {}) => call<ProbeResult>(providerUrl(slug, "test"), send("POST", input));
export const connectProvider = (slug: string, input: ConnectInput = {}) => call<ProbeResult>(providerUrl(slug, "connect"), send("POST", input));
export const detectProvider = (slug: string) => call<DetectResult>(providerUrl(slug, "detect"), send("POST", {}));
export const disconnectProvider = (slug: string) => call<{ chain: ChainLink[] }>(providerUrl(slug, "connection"), { method: "DELETE" });
export const saveChain = (links: ChainLink[]) => call<{ chain: ChainLink[] }>("/api/llm/chain", send("PUT", { links }));

/** Models of a provider that is already connected and running. */
export async function fetchLiveModels(slug: string): Promise<string[]> {
  const body = await call<{ models?: unknown[] }>(providerUrl(slug, "models"));
  return modelIds((body.models ?? []) as never);
}

/** Builds the request body from the connect form: only the fields the
 *  provider actually accepts, trimmed, and never a baseUrl that matches
 *  the provider's own default. */
export function connectInputFor(
  p: CatalogProvider,
  form: { apiKey: string; model: string; region: string; baseUrl: string },
): ConnectInput {
  const out: ConnectInput = {};
  const apiKey = form.apiKey.trim();
  if (p.needsKey && apiKey) out.apiKey = apiKey;
  if (form.model.trim()) out.model = form.model.trim();
  if (p.regions.length > 0 && form.region) out.region = form.region;
  if ((p.group === "local" || p.baseUrlEditable) && !p.needsKey && form.baseUrl.trim()) out.baseUrl = form.baseUrl.trim();
  else if (p.baseUrlEditable && p.needsKey && form.baseUrl.trim() && form.baseUrl.trim() !== p.baseUrl) out.baseUrl = form.baseUrl.trim();
  return out;
}

/** Whether the Connect button can do anything useful right now. */
export function canConnect(p: CatalogProvider, form: { apiKey: string; baseUrl: string }, busy: boolean): boolean {
  if (busy) return false;
  if (p.needsKey) return form.apiKey.trim() !== "" || p.keyMasked !== "";
  if (p.group === "local") return form.baseUrl.trim() !== "";
  return true;
}

/** Swaps a chain link with its neighbour; out of range returns an unchanged copy. */
export function moveLink(chain: ChainLink[], index: number, dir: -1 | 1): ChainLink[] {
  const out = chain.map((l) => ({ ...l }));
  const to = index + dir;
  if (index < 0 || index >= out.length || to < 0 || to >= out.length) return out;
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

/** Connected providers for the Settings list: chain order first, then the rest in catalog order. */
export function connectionRows(providers: CatalogProvider[], chain: ChainLink[]): CatalogProvider[] {
  const connected = providers.filter((p) => p.connected);
  const rank = (slug: string) => {
    const i = chain.findIndex((l) => l.provider === slug);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return connected
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p.slug) - rank(b.p.slug) || a.i - b.i)
    .map((x) => x.p);
}

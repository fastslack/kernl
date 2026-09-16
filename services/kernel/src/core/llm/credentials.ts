/**
 * The only way anything in Kernl reads an LLM provider's key, URL or model.
 *
 * Keys used to live in two stores that disagreed — the provider registry and
 * `.env`/`app_settings` — and a restart could put an old key back over a new
 * one. The registry is now the only store; this module is its reader.
 *
 * The source is kept on `globalThis`, not in a module variable: every extension
 * bundle carries its own copy of `src/`, so a module-level variable would be a
 * different, empty one inside each extension. `llm()` solves the same problem
 * the same way (`globalThis.__llm`).
 */

import { PROVIDER_CATALOG, canonicalSlug, getCatalogEntry, type ProviderCatalogEntry } from "./provider-catalog.js";

export interface CredentialSource {
  loadConfig(slug: string): Record<string, unknown>;
  saveConfig(slug: string, cfg: Record<string, unknown>): boolean;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  region: string;
  oauthToken: string;
}

type Holder = { __kernlLlmCredentials?: CredentialSource | null };

export function setCredentialSource(source: CredentialSource | null): void {
  (globalThis as Holder).__kernlLlmCredentials = source;
}

function source(): CredentialSource | null {
  return (globalThis as Holder).__kernlLlmCredentials ?? null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function getStoredConfig(slugOrAlias: string): Record<string, unknown> {
  try {
    return source()?.loadConfig(canonicalSlug(slugOrAlias)) ?? {};
  } catch {
    return {};
  }
}

export function resolveProviderConfig(entry: ProviderCatalogEntry, raw: Record<string, unknown>): ProviderConfig {
  const region = str(raw.region);
  const regionBase = entry.regions?.find((r) => r.id === region)?.baseUrl;
  // A stored URL only counts where the user can actually set one. For the
  // rest it can only be stale, and following it would send the key elsewhere.
  const storedBase = entry.baseUrlEditable ? str(raw.baseUrl) : "";
  return {
    apiKey: str(raw.apiKey),
    baseUrl: storedBase || regionBase || entry.baseUrl,
    model: str(raw.defaultModel) || entry.models.recommended || "",
    region,
    oauthToken: str(raw.oauthToken),
  };
}

export function getProviderConfig(slugOrAlias: string): ProviderConfig {
  const entry = getCatalogEntry(slugOrAlias);
  if (!entry) return { apiKey: "", baseUrl: "", model: "", region: "", oauthToken: "" };
  return resolveProviderConfig(entry, getStoredConfig(entry.slug));
}

/** Connected means the user finished connecting it, and it still has what it needs. */
export function isConnected(slugOrAlias: string): boolean {
  const entry = getCatalogEntry(slugOrAlias);
  if (!entry) return false;
  const raw = getStoredConfig(entry.slug);
  if (!str(raw.connectedAt)) return false;
  return entry.needsKey ? str(raw.apiKey) !== "" : true;
}

export function listConnected(): string[] {
  return PROVIDER_CATALOG.filter((e) => isConnected(e.slug)).map((e) => e.slug);
}

export function saveProviderConfig(slugOrAlias: string, patch: Record<string, unknown>): boolean {
  const s = source();
  if (!s) return false;
  const slug = canonicalSlug(slugOrAlias);
  const next: Record<string, unknown> = { ...getStoredConfig(slug) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return s.saveConfig(slug, next);
}

export function clearProviderConfig(slugOrAlias: string): boolean {
  const s = source();
  if (!s) return false;
  return s.saveConfig(canonicalSlug(slugOrAlias), {});
}

/**
 * Transitional compatibility for code that still reads provider credentials
 * the old way. Nothing here touches `.env`.
 *
 *  - `config.webIntel.*ApiKey` / `config.voice.openaiApiKey` become accessors
 *    over the registry, so extensions that read them keep working.
 *  - `GROQ_API_KEY` is mirrored into the in-memory environment from the
 *    registry, because the cinema and torrents transcribers read it there.
 *
 * Both go away once extensions reach credentials through the SDK host.
 */

import type { KernelConfig } from "../config.js";
import { getProviderConfig, getStoredConfig, isConnected, saveProviderConfig } from "./credentials.js";

type Field = "apiKey" | "baseUrl" | "defaultModel" | "region";

export const LEGACY_CREDENTIAL_ENV: Record<string, { slug: string; field: Field }> = {
  ANTHROPIC_API_KEY: { slug: "claude", field: "apiKey" },
  OPENAI_API_KEY: { slug: "openai", field: "apiKey" },
  OPENAI_BASE_URL: { slug: "openai", field: "baseUrl" },
  OPENAI_DEFAULT_MODEL: { slug: "openai", field: "defaultModel" },
  GROK_API_KEY: { slug: "grok", field: "apiKey" },
  XAI_API_KEY: { slug: "grok", field: "apiKey" },
  GROK_DEFAULT_MODEL: { slug: "grok", field: "defaultModel" },
  NVIDIA_API_KEY: { slug: "nvidia", field: "apiKey" },
  NVIDIA_DEFAULT_MODEL: { slug: "nvidia", field: "defaultModel" },
  MINIMAX_API_KEY: { slug: "minimax", field: "apiKey" },
  MINIMAX_BASE_URL: { slug: "minimax", field: "region" },
  MINIMAX_DEFAULT_MODEL: { slug: "minimax", field: "defaultModel" },
  LMSTUDIO_BASE_URL: { slug: "lmstudio", field: "baseUrl" },
  LMSTUDIO_API_KEY: { slug: "lmstudio", field: "apiKey" },
  GROQ_API_KEY: { slug: "groq", field: "apiKey" },
};

export function legacyCredentialTarget(envKey: string): { slug: string; field: Field } | undefined {
  return LEGACY_CREDENTIAL_ENV[envKey];
}

export function legacyToStoredPatch(envKey: string, value: string): { slug: string; patch: Record<string, unknown> } | undefined {
  const target = LEGACY_CREDENTIAL_ENV[envKey];
  const v = value.trim();
  if (!target || !v) return undefined;
  if (target.field === "region") {
    return { slug: target.slug, patch: { region: /minimax\.cn/i.test(v) ? "china" : "global" } };
  }
  const patch: Record<string, unknown> = { [target.field]: v };
  if (target.field === "apiKey" || target.field === "baseUrl") {
    patch.connectedAt = (getStoredConfig(target.slug).connectedAt as string | undefined) ?? new Date().toISOString();
  }
  return { slug: target.slug, patch };
}

const MIRRORED: Array<{ group: "webIntel" | "voice"; field: string; slug: string; part: "apiKey" | "defaultModel" | "baseUrl" }> = [
  { group: "webIntel", field: "anthropicApiKey", slug: "claude", part: "apiKey" },
  { group: "webIntel", field: "openaiApiKey", slug: "openai", part: "apiKey" },
  { group: "webIntel", field: "grokApiKey", slug: "grok", part: "apiKey" },
  { group: "webIntel", field: "grokDefaultModel", slug: "grok", part: "defaultModel" },
  { group: "webIntel", field: "nvidiaApiKey", slug: "nvidia", part: "apiKey" },
  { group: "webIntel", field: "nvidiaDefaultModel", slug: "nvidia", part: "defaultModel" },
  { group: "webIntel", field: "lmstudioBaseUrl", slug: "lmstudio", part: "baseUrl" },
  { group: "voice", field: "openaiApiKey", slug: "openai", part: "apiKey" },
];

export function installLegacyCredentialMirror(config: KernelConfig): void {
  for (const m of MIRRORED) {
    const target = config[m.group] as unknown as Record<string, unknown>;
    Object.defineProperty(target, m.field, {
      configurable: true,
      enumerable: true,
      get: () => {
        if (m.part === "apiKey") return getProviderConfig(m.slug).apiKey;
        if (m.part === "defaultModel") {
          const v = getStoredConfig(m.slug).defaultModel;
          return typeof v === "string" ? v : "";
        }
        // Consumers treat a non-empty URL as "LM Studio is in use".
        return isConnected(m.slug) ? getProviderConfig(m.slug).baseUrl : "";
      },
      set: (value: unknown) => {
        if (typeof value !== "string" || !value.trim()) return;
        const patch: Record<string, unknown> = { [m.part]: value.trim() };
        if (m.part !== "defaultModel") {
          patch.connectedAt = (getStoredConfig(m.slug).connectedAt as string | undefined) ?? new Date().toISOString();
        }
        saveProviderConfig(m.slug, patch);
      },
    });
  }
}

export const DEFERRED_ENV_MIRROR: Record<string, string> = { GROQ_API_KEY: "groq" };

export function mirrorDeferredEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, slug] of Object.entries(DEFERRED_ENV_MIRROR)) {
    const key = getProviderConfig(slug).apiKey;
    if (key) env[name] = key;
    else delete env[name];
  }
}

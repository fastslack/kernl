/**
 * Legacy env-var → registry mapping. Kept for code that still saves a
 * setting under its old `ANTHROPIC_API_KEY`-style name (kernel_config_set,
 * the .env migration) and needs to know which registry slug/field that maps
 * to. Nothing here touches `.env`.
 */

import { getStoredConfig } from "./credentials.js";

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

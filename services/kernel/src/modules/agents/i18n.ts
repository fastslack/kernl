import type { KernelConfig, KernelLanguage } from "../../core/config.js";
import type { Agent } from "./types.js";

const VALID_LANGUAGES: ReadonlySet<KernelLanguage> = new Set(["es", "en"]);

/**
 * An agent's effective language: `language_override` beats `config.language`.
 * Any invalid value in the override is discarded and we inherit from config.
 * Centralising this here stops every executor from reading
 * `configRef?.language ?? "en"` on its own and forgetting the agent override.
 */
export function resolveAgentLanguage(
  agent: Pick<Agent, "language_override">,
  config?: Pick<KernelConfig, "language"> | null,
): KernelLanguage {
  const override = (agent.language_override ?? "").trim().toLowerCase();
  if (override && VALID_LANGUAGES.has(override as KernelLanguage)) {
    return override as KernelLanguage;
  }
  return config?.language ?? "es";
}

/**
 * Resolve an agent's i18n field.
 * - If the `*_i18n` column holds valid JSON for the requested language, return it.
 * - Otherwise try the fallback language ("en" when "es" was asked for and is missing, or vice versa).
 * - Last resort: return the original column (the un-suffixed field).
 */
export function resolveI18nField(
  i18nRaw: string | null | undefined,
  fallbackRaw: string,
  language: KernelLanguage,
): string {
  if (i18nRaw && i18nRaw.length > 0) {
    try {
      const map = JSON.parse(i18nRaw) as Record<string, string>;
      if (map && typeof map === "object") {
        const primary = map[language];
        if (primary && primary.trim().length > 0) return primary;
        const other: KernelLanguage = language === "es" ? "en" : "es";
        const fb = map[other];
        if (fb && fb.trim().length > 0) return fb;
      }
    } catch {
      // Invalid JSON — ignore it and use the fallback.
    }
  }
  return fallbackRaw ?? "";
}

/** Typed shortcuts for an Agent's three translatable fields. */
export function resolveAgentSystemPrompt(agent: Agent, language: KernelLanguage): string {
  return resolveI18nField(agent.system_prompt_i18n, agent.system_prompt ?? "", language);
}

export function resolveAgentGoalTemplate(agent: Agent, language: KernelLanguage): string {
  return resolveI18nField(agent.goal_template_i18n, agent.goal_template ?? "", language);
}

export function resolveAgentDescription(agent: Agent, language: KernelLanguage): string {
  return resolveI18nField(agent.description_i18n, agent.description ?? "", language);
}

/**
 * Build the JSON to store in the `*_i18n` columns.
 * Empty values are omitted so we waste no space and don't confuse the resolver.
 */
export function buildI18nJson(values: Partial<Record<KernelLanguage, string>>): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v && v.trim().length > 0) clean[k] = v;
  }
  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : "";
}

/**
 * Mirror each provider's settings_json (the source of truth) into the legacy
 * KernelConfig fields the rest of the app still reads. Keeps chat/agents/
 * web-intel/llm() working without forcing every caller onto the registry yet.
 */

import type { KernelConfig } from "../config.js";

interface ConfigLoader {
  loadConfig(slug: string): Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function syncProvidersToKernelConfig(config: KernelConfig, registry: ConfigLoader): void {
  const claude = registry.loadConfig("claude");
  const openai = registry.loadConfig("openai");
  const grok = registry.loadConfig("grok");
  const nvidia = registry.loadConfig("nvidia");
  const lmstudio = registry.loadConfig("lmstudio");
  const minimax = registry.loadConfig("minimax");

  // MiniMax has no config.webIntel home (it's a registry-native provider). The
  // chat adapter / web-intel read it from process.env, so mirror it there so a
  // value saved in the registry is visible after a restart even without .env.
  const mmKey = str(minimax.apiKey);
  if (mmKey !== undefined) process.env.MINIMAX_API_KEY = mmKey;
  const mmBase = str(minimax.baseUrl);
  if (mmBase !== undefined) process.env.MINIMAX_BASE_URL = mmBase;
  const mmModel = str(minimax.defaultModel);
  if (mmModel !== undefined) process.env.MINIMAX_DEFAULT_MODEL = mmModel;

  const wi = config.webIntel as unknown as Record<string, unknown>;
  const setIf = (obj: Record<string, unknown>, key: string, v: string | undefined) => {
    if (v !== undefined) obj[key] = v;
  };

  setIf(wi, "anthropicApiKey", str(claude.apiKey));
  setIf(wi, "openaiApiKey", str(openai.apiKey));
  setIf(wi, "grokApiKey", str(grok.apiKey));
  setIf(wi, "grokDefaultModel", str(grok.defaultModel));
  setIf(wi, "nvidiaApiKey", str(nvidia.apiKey));
  setIf(wi, "nvidiaDefaultModel", str(nvidia.defaultModel));
  setIf(wi, "lmstudioBaseUrl", str(lmstudio.baseUrl));

  const oaiKey = str(openai.apiKey);
  if (oaiKey !== undefined) (config.voice as unknown as Record<string, unknown>).openaiApiKey = oaiKey;
}

/** Per-provider mapping from settings_json field → legacy .env var name. */
const PROVIDER_ENV_MAP: Record<string, Record<string, string>> = {
  claude: { apiKey: "ANTHROPIC_API_KEY" },
  openai: { apiKey: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL", defaultModel: "OPENAI_DEFAULT_MODEL" },
  grok: { apiKey: "GROK_API_KEY", defaultModel: "GROK_DEFAULT_MODEL" },
  nvidia: { apiKey: "NVIDIA_API_KEY", defaultModel: "NVIDIA_DEFAULT_MODEL" },
  lmstudio: { baseUrl: "LMSTUDIO_BASE_URL" },
  minimax: { apiKey: "MINIMAX_API_KEY", baseUrl: "MINIMAX_BASE_URL", defaultModel: "MINIMAX_DEFAULT_MODEL" },
};

/**
 * Build the .env updates for one provider's saved config, also mutating
 * process.env so the change is visible in-process immediately. Returns the
 * map the caller persists with writeEnvFile().
 */
export function providerEnvUpdates(slug: string, cfg: Record<string, unknown>): Record<string, string> {
  const map = PROVIDER_ENV_MAP[slug] ?? {};
  const out: Record<string, string> = {};
  for (const [field, envKey] of Object.entries(map)) {
    const v = cfg[field];
    if (typeof v === "string" && v) { out[envKey] = v; process.env[envKey] = v; }
  }
  return out;
}

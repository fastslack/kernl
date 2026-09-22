/** Build chat adapters from the provider catalog + stored credentials. */
import { ChatClaudeCodeProvider, type ClaudeCodeProviderOptions } from "./claude-code-adapter.js";
import { PROVIDER_CATALOG, getCatalogEntry } from "./provider-catalog.js";
import { getProviderConfig, isConnected, type ProviderConfig } from "./credentials.js";
import type { ChatLlmProvider } from "./chat-provider.js";
import { ChatClaudeProvider, CLAUDE_DEFAULT_MODEL } from "./chat-claude.js";
import { ChatOpenAiProvider } from "./chat-openai.js";
import { ChatLmStudioProvider } from "./chat-lmstudio.js";
import { instrumentProvider } from "./chat-instrumentation.js";

export interface AdapterOptions {
  /** Kernel-wide chat default, used where the provider has no model of its own. */
  defaultModel?: string;
  /** Claude Code subprocess/MCP wiring (from `config.claudeCode`). */
  claudeCode?: ClaudeCodeProviderOptions;
}

/**
 * One chat adapter for one catalog provider, built from its stored config.
 *
 * `override` lets the connect dialog test a key the user just pasted without
 * saving it first: non-empty strings replace the stored values, nothing is
 * written anywhere.
 */
export function buildChatAdapter(
  slugOrAlias: string,
  override: Partial<ProviderConfig> = {},
  opts: AdapterOptions = {},
): ChatLlmProvider | null {
  const entry = getCatalogEntry(slugOrAlias);
  if (!entry) return null;
  const cfg: ProviderConfig = { ...getProviderConfig(entry.slug) };
  for (const key of ["apiKey", "baseUrl", "model", "region", "oauthToken"] as const) {
    const v = override[key];
    if (typeof v === "string" && v.trim() !== "") cfg[key] = v.trim();
  }
  if (override.region && !override.baseUrl) {
    const regionBase = entry.regions?.find((r) => r.id === override.region)?.baseUrl;
    if (regionBase) cfg.baseUrl = regionBase;
  }

  switch (entry.kind) {
    case "anthropic":
      return new ChatClaudeProvider(cfg.apiKey, cfg.model || opts.defaultModel || CLAUDE_DEFAULT_MODEL);
    case "claude-code":
      return new ChatClaudeCodeProvider(opts.defaultModel, {
        ...opts.claudeCode,
        model: cfg.model,
        ...(cfg.oauthToken ? { oauthToken: cfg.oauthToken } : {}),
      });
    case "lmstudio":
      return new ChatLmStudioProvider(cfg.baseUrl, cfg.model);
    default:
      // Local OpenAI-compatible servers ignore auth but the header must not be empty.
      return new ChatOpenAiProvider(entry.needsKey ? cfg.apiKey : (cfg.apiKey || "local"), cfg.baseUrl, cfg.model, entry.slug);
  }
}

export function createChatProviders(options: AdapterOptions = {}): Map<string, ChatLlmProvider> {
  const providers = new Map<string, ChatLlmProvider>();
  for (const entry of PROVIDER_CATALOG) {
    // A local server needs no key, so an unconnected one would still report
    // available() and get picked as a fallback that can only time out.
    if (entry.group === "local" && !isConnected(entry.slug)) continue;
    const adapter = buildChatAdapter(entry.slug, {}, options);
    if (!adapter) continue;
    // One instance under the slug and every alias: stored agent rows use
    // "claude_code", the registry and dashboard use "claude-code".
    const instance = instrumentProvider(adapter);
    providers.set(entry.slug, instance);
    for (const alias of entry.aliases) providers.set(alias, instance);
  }
  return providers;
}

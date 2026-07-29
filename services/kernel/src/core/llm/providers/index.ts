/**
 * Built-in LLM providers (factories para LlmProviderRegistry).
 *
 * Each factory wraps an existing class from `chat/llm-adapter.ts` — it does
 * NOT reimplement the HTTP logic. That avoids duplication and keeps the
 * migration path purely additive: callers of the `chat` module keep working,
 * new callers can use the Registry.
 *
 * Once every caller has moved to the Registry, the logic can be physically
 * moved out of `chat/llm-adapter.ts` into individual files in this
 * directory (`claude-provider.ts`, etc.) and the `chat` facade becomes
 * un re-export.
 */

export { createClaudeProvider } from "./claude-provider.js";
export { createClaudeCodeProvider } from "./claude-code-provider.js";
export { createOpenAiProvider } from "./openai-provider.js";
export { createGrokProvider } from "./grok-provider.js";
export { createNvidiaProvider } from "./nvidia-provider.js";
export { createLmStudioProvider } from "./lmstudio-provider.js";
export { createMinimaxProvider } from "./minimax-provider.js";

import type { LlmProviderRegistry } from "../provider-registry.js";
import { createClaudeProvider } from "./claude-provider.js";
import { createClaudeCodeProvider } from "./claude-code-provider.js";
import { createOpenAiProvider } from "./openai-provider.js";
import { createGrokProvider } from "./grok-provider.js";
import { createNvidiaProvider } from "./nvidia-provider.js";
import { createLmStudioProvider } from "./lmstudio-provider.js";
import { createMinimaxProvider } from "./minimax-provider.js";

/**
 * Helper to register the built-in providers on a registry. Call it from
 * the bootstrap after `new LlmProviderRegistry()`.
 *
 * Note: `claude` and `claude-code` are separate extensions even though they point at the
 * same model family. `claude` = REST API + API key (billed per
 * token). `claude-code` = CLI subprocess + OAuth (inside the Max/Pro sub,
 * trae skills/plugins/MCPs/built-in tools).
 */
export function registerBuiltinLlmProviders(registry: LlmProviderRegistry): void {
  registry.registerFactory("claude", createClaudeProvider, "builtin");
  registry.registerFactory("claude-code", createClaudeCodeProvider, "builtin");
  registry.registerFactory("openai", createOpenAiProvider, "builtin");
  registry.registerFactory("grok", createGrokProvider, "builtin");
  registry.registerFactory("nvidia", createNvidiaProvider, "builtin");
  registry.registerFactory("lmstudio", createLmStudioProvider, "builtin");
  registry.registerFactory("minimax", createMinimaxProvider, "builtin");
}

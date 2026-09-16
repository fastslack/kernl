/**
 * Built-in LLM providers (factories for LlmProviderRegistry), one per catalog
 * entry. Anthropic, Claude Code and LM Studio keep dedicated implementations —
 * a native API, a CLI subprocess and the Responses API with model detection.
 * Everything else is OpenAI-compatible and served by one class.
 */

export { createClaudeProvider } from "./claude-provider.js";
export { createClaudeCodeProvider } from "./claude-code-provider.js";
export { createLmStudioProvider } from "./lmstudio-provider.js";
export { createCatalogProvider } from "./openai-compatible-provider.js";

import type { LlmProviderRegistry } from "../provider-registry.js";
import { PROVIDER_CATALOG } from "../provider-catalog.js";
import { createClaudeProvider } from "./claude-provider.js";
import { createClaudeCodeProvider } from "./claude-code-provider.js";
import { createLmStudioProvider } from "./lmstudio-provider.js";
import { createCatalogProvider } from "./openai-compatible-provider.js";

export function registerBuiltinLlmProviders(registry: LlmProviderRegistry): void {
  for (const entry of PROVIDER_CATALOG) {
    const factory =
      entry.kind === "anthropic" ? createClaudeProvider
      : entry.kind === "claude-code" ? createClaudeCodeProvider
      : entry.kind === "lmstudio" ? createLmStudioProvider
      : createCatalogProvider(entry.slug);
    registry.registerFactory(entry.slug, factory, "builtin");
  }
}

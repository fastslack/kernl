/**
 * Chat adapters — barrel.
 *
 * The code lives in one file per responsibility; this module keeps the public
 * surface every importer (kernel modules, `modules/chat/llm-adapter.ts`, the
 * extensions bundled through it, tests) has always used:
 *
 *   chat-provider.ts        ChatLlmProvider contract, tool caps, HTTP timeout
 *   chat-messages.ts        kernel messages → OpenAI / Responses wire formats
 *   chat-claude.ts          Anthropic Messages adapter
 *   chat-openai.ts          OpenAI-compatible chat/completions adapter
 *   chat-lmstudio.ts        LM Studio (OpenAI Responses API) adapter
 *   chat-instrumentation.ts provider-health + LLM log wrapping
 *   chat-factory.ts         buildChatAdapter / createChatProviders
 *   provider-quota.ts       quota-exhaustion tracking (+ its DB migration)
 *   provider-resolution.ts  resolveProvider / resolveProviderFor
 *   retry.ts                429 backoff + Retry-After parsing (shared with LlmClient)
 */

export type { ChatLlmProvider } from "./chat-provider.js";
export { truncateTools } from "./chat-provider.js";
export { ChatClaudeProvider } from "./chat-claude.js";
export { ChatOpenAiProvider } from "./chat-openai.js";
export { ChatLmStudioProvider } from "./chat-lmstudio.js";
export type { AdapterOptions } from "./chat-factory.js";
export { buildChatAdapter, createChatProviders } from "./chat-factory.js";
export {
  providerStatusMigrations,
  initProviderStatus,
  markProviderExhausted,
  isProviderExhausted,
  clearProviderExhausted,
} from "./provider-quota.js";
export { resolveProviderFor, resolveProvider } from "./provider-resolution.js";

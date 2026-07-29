/**
 * @deprecated Moved to `core/llm/chat-adapters.js` — import from there.
 *
 * The chat provider implementations (ChatClaudeProvider, ChatOpenAiProvider,
 * ChatGrokProvider, ChatNvidiaProvider, ChatMinimaxProvider,
 * ChatLmStudioProvider, createChatProviders, resolveProvider, the provider
 * quota-exhaustion helpers, the ChatLlmProvider type, …) were relocated into
 * core so that `core/llm/*` no longer imports upward from `modules/chat`.
 *
 * This shim re-exports everything for back-compat — kernel-internal callers
 * should import from `core/llm/chat-adapters.js` directly, but extensions and
 * older code keep working through this path.
 */
export * from "../../core/llm/chat-adapters.js";

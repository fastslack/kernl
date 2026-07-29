/**
 * @deprecated Moved to `core/llm/claude-code-adapter.js` — import from there.
 *
 * `ChatClaudeCodeProvider` (chat completions via the logged-in Claude Code CLI)
 * was relocated into core so that `core/llm/*` no longer imports upward from
 * `modules/chat`. This shim re-exports it for back-compat.
 */
export * from "../../core/llm/claude-code-adapter.js";

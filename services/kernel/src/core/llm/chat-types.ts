/**
 * LLM wire types — the Anthropic-shaped message / content-block / completion
 * types used by the chat adapters that live in `core/llm/`.
 *
 * These moved down from `modules/chat/types.ts` when the provider
 * implementations were relocated into core (core must never import from
 * modules). `modules/chat/types.ts` re-exports every symbol here, so existing
 * chat-domain code and extensions keep importing them from the old path.
 */

/** Message format for LLM APIs — content can be string or array of content blocks (for tool use) */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

/** Image content block for vision-capable models */
export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  };
}

/** Document content block (PDFs) — Anthropic format */
export interface DocumentBlock {
  type: "document";
  source: {
    type: "base64";
    media_type: "application/pdf";
    data: string;
  };
}

/** A content block within a message (Anthropic API format) */
export type ContentBlock =
  | { type: "text"; text: string }
  | ImageBlock
  | DocumentBlock
  | ToolUseBlock
  | ToolResultBlock;

/** Tool use request from the LLM */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Tool result sent back to the LLM */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Tool definition in Anthropic API format */
export interface ToolDefinitionForLlm {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Result from an LLM chat completion */
export interface ChatCompletionResult {
  content: string;
  model: string;
  tokens_used: number;
  tool_calls?: ToolUseBlock[];
  stop_reason?: string;
}

/** Options for chat completion */
export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  system?: string;
  tools?: ToolDefinitionForLlm[];
  /** Called when a 429 rate limit triggers a retry wait */
  onRateLimitWait?: (waitMs: number, attempt: number) => void;
  /**
   * Free-form context tag included in LLM call logs (e.g. agent name,
   * "auto-eval", "chat-ui"). Purely diagnostic — never sent to the upstream.
   */
  caller?: string;
}

/**
 * Streaming events emitted by the claude_code provider's streaming path.
 * The SSE route writes one of these per `event:` line; the dashboard
 * branches on `type` to render text deltas, tool calls, tool results,
 * permission prompts and the final summary.
 */
export type ChatStreamEvent =
  | { type: "assistant_text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }
  | {
      type: "permission_request";
      request_id: string;
      tool_name: string;
      input: Record<string, unknown>;
    }
  | { type: "system"; subtype: string; data: Record<string, unknown> }
  | { type: "session"; session_id: string }
  | {
      type: "done";
      final_text: string;
      tokens_used: number;
      stop_reason?: string;
      message_id: string;
    }
  | { type: "error"; message: string };

/** Sink the provider streams events into. */
export type ChatStreamSink = (ev: ChatStreamEvent) => void;

/** Resolver used by the SDK's canUseTool hook to ask the dashboard. */
export interface PermissionRequester {
  ask(input: {
    request_id: string;
    tool_name: string;
    input: Record<string, unknown>;
  }): Promise<{ behavior: "allow" | "deny"; reason?: string }>;
}

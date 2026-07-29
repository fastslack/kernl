/**
 * LLM wire types (ChatMessage, ContentBlock, ToolUseBlock, ChatCompletionResult,
 * streaming events, …) moved down to `core/llm/chat-types.ts` when the provider
 * implementations were relocated into core. They are re-exported here so
 * existing imports from `modules/chat/types.js` keep working unchanged.
 */
export type {
  ChatMessage,
  ImageBlock,
  DocumentBlock,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDefinitionForLlm,
  ChatCompletionResult,
  ChatCompletionOptions,
  ChatStreamEvent,
  ChatStreamSink,
  PermissionRequester,
} from "../../core/llm/chat-types.js";

// Local binding for the types below that still reference PermissionRequester.
import type { PermissionRequester } from "../../core/llm/chat-types.js";

/** A chat episode (conversation session) */
export interface Episode {
  id: string;
  title: string;
  summary: string;
  status: "active" | "archived";
  message_count: number;
  llm_provider: string;
  llm_model: string;
  total_tokens: number;
  /** Claude Agent SDK session id — used to resume tool_use history across turns. */
  sdk_session_id?: string;
  /** Per-episode system instructions appended to SOUL. Empty for default chats. */
  instructions?: string;
  created_at: string;
  updated_at: string;
}

/** A single message within an episode */
export interface Message {
  id: string;
  episode_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  token_count: number;
  context_used: string;
  extraction_data: string;
  /**
   * Structured SDK content blocks (text + tool_use + tool_result), JSON-encoded.
   * Empty string when the message comes from a non-streaming provider — the
   * plain `content` column is the source of truth in that case.
   */
  content_blocks: string;
  created_at: string;
}

/** An entity extracted from a message */
export interface Extraction {
  id: string;
  message_id: string;
  entity_type: "person" | "task" | "note" | "concept" | "preference" | "fact";
  entity_id: string;
  label: string;
  confidence: number;
  created_at: string;
}

/** Full chat response including context metadata */
export interface ChatResponse {
  message: Message;
  context_summary: string;
  tokens_used: number;
}

/** Options the streaming chat path accepts (superset of ChatCompletionOptions). */
export interface ChatStreamOptions {
  images?: Array<{ data: string; media_type: string }>;
  documents?: Array<{ data: string; media_type: string; filename?: string }>;
  permission?: PermissionRequester;
}

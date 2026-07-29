/**
 * Unified LLM provider interface — the contract for every chat/completion
 * provider in Kernl. Replaces the `chat` module's `ChatLlmProvider` with an
 * abstraction that lives in core, following the same mould as
 * `SandboxDriver`: factory+registry+lifecycle+config.
 *
 * Built-in implementations: claude, openai, grok, lmstudio (see
 * `src/core/llm/providers/`). Extensions with `type: "llm-provider"` can
 * contribute new ones (OpenRouter, DeepSeek, Ollama, etc.) without touching the kernel.
 *
 * This file documents the contract only. Migrating the consuming code
 * (21 reverse deps) is planned in
 * `docs/architecture/phases/llm-provider-migration.md`.
 */

import type { ConfigField } from "../notify/provider.js";

export type { ConfigField };

// ── Message / response types ──────────────────────────────────────────

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional: structured blocks (tool_use / tool_result) for providers that support them. */
  blocks?: Array<Record<string, unknown>>;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatCompletionOptions {
  /** Model identifier (provider-specific). Empty means the driver's default. */
  model?: string;
  temperature?: number;
  max_tokens?: number;
  system?: string;
  tools?: ToolSpec[];
  /** Abort signal para cancelar midway. */
  signal?: AbortSignal;
  /** Stop sequences custom. */
  stop?: string[];
  /** Allows passthrough of provider-specific options without breaking the contract. */
  extras?: Record<string, unknown>;
}

export interface ChatToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatCompletionResult {
  /** Final concatenated text. Drivers returning structured blocks may leave this empty. */
  content: string;
  /** Structured blocks (optional). Useful for agents. */
  blocks?: Array<Record<string, unknown>>;
  /** Tool calls extraídos (si el provider soporta tool use). */
  tool_calls?: ChatToolCall[];
  /** Stop reason reportado por el provider. */
  stop_reason?: string;
  /** Uso de tokens. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** The model the provider actually used. */
  model?: string;
}

// ── Capabilities ──────────────────────────────────────────────────────

export interface LlmProviderCapabilities {
  /** Acepta `tools` en las options y devuelve `tool_calls` estructurados. */
  tools: boolean;
  /** Soporta streaming via AsyncIterable. */
  streaming: boolean;
  /** Soporta thinking/extended-reasoning. */
  thinking: boolean;
  /** Supports vision (image input). */
  vision: boolean;
  /** Soporta prompt caching. */
  promptCaching: boolean;
  /** Approximate max context size (tokens) — for UI defaults. */
  contextWindow: number;
}

// ── Status ────────────────────────────────────────────────────────────

export interface LlmProviderStatus {
  slug: string;
  name: string;
  /** Whether the driver started up and is ready for chatCompletion. */
  ready: boolean;
  /** Origen del driver (builtin o extension). */
  source?: "builtin" | "extension";
  /** Last reported error, if any. */
  error?: string;
  /** Si el provider reportó quota agotada. */
  exhausted?: boolean;
  /** Last model used successfully (for the UI). */
  lastModel?: string;
  /** Capabilities reportadas por el driver. */
  capabilities?: LlmProviderCapabilities;
}

// ── Driver contract ───────────────────────────────────────────────────

/**
 * LlmProviders implement this contract. Same style as SandboxDriver:
 *   - `configure(cfg)` recibe la config persistida
 *   - `start()` inicializa clientes y hace healthcheck
 *   - `stop()` libera recursos
 * El método central es `chatCompletion()`.
 */
export interface LlmProvider {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: LlmProviderCapabilities;

  /** Aplica config persistida (api key, base URL, default model). */
  configure(config: Record<string, unknown>): void;

  /** Inicializa el provider y verifica readiness. Idempotente. */
  start(): Promise<void>;

  /** Libera recursos. Idempotente. */
  stop(): Promise<void>;

  /** Healthcheck sin llamadas a la API. */
  isReady(): boolean;

  /** Estado actual para /status. */
  getStatus(): LlmProviderStatus;

  /** JSON Schema for the config form in the dashboard. */
  getConfigSchema(): ConfigField[];

  /**
   * Completa un chat. Debe respetar `opts.signal` si viene. Si el provider no
   * supports tools but `opts.tools` is supplied, it must return plain text,
   * las tools (no lanzar).
   */
  chatCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult>;

  /**
   * Optional — token-by-token delta stream. Drivers without streaming
   * support may omit this method; the registry detects the capability.
   */
  chatStream?(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): AsyncIterable<{ delta: string; done?: boolean; usage?: ChatCompletionResult["usage"] }>;

  /**
   * Optional — list of models available on this provider (for the UI).
   * Some providers (lmstudio) discover their models dynamically.
   */
  listModels?(): Promise<string[]>;
}

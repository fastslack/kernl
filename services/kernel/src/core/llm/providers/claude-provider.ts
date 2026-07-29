/**
 * Built-in LLM provider — Claude (Anthropic).
 *
 * Wrapper alrededor de `ChatClaudeProvider` en `chat/llm-adapter.ts`. Implementa
 * the core `LlmProvider` contract, delegating the real logic to the
 * existing adapter. Once every caller moves to the Registry, the logic can
 * be physically moved here.
 */

import { ChatClaudeProvider } from "../chat-adapters.js";
import type {
  LlmProvider,
  LlmProviderCapabilities,
  LlmProviderStatus,
  ChatMessage,
  ChatCompletionOptions,
  ChatCompletionResult,
  ConfigField,
} from "../provider.js";

const CAPS: LlmProviderCapabilities = {
  tools: true,
  streaming: false, // the current adapter exposes no streaming, even though the SDK supports it
  thinking: true,
  vision: true,
  promptCaching: true,
  contextWindow: 200_000,
};

class ClaudeProviderImpl implements LlmProvider {
  readonly slug = "claude";
  readonly name = "Anthropic Claude";
  readonly capabilities = CAPS;

  private impl: ChatClaudeProvider | null = null;
  private apiKey = "";
  private defaultModel = "claude-sonnet-4-20250514";
  private lastError?: string;
  private lastModel?: string;

  configure(config: Record<string, unknown>): void {
    // Prioridad: config persistida > env var (ANTHROPIC_API_KEY). Permite que
    // the provider works out of the box with the keys from .env, without
    // going through the dashboard, while still letting the user override in the UI.
    this.apiKey = typeof config.apiKey === "string" && config.apiKey
      ? config.apiKey
      : (process.env.ANTHROPIC_API_KEY ?? "");
    if (typeof config.defaultModel === "string" && config.defaultModel) {
      this.defaultModel = config.defaultModel;
    }
  }

  async start(): Promise<void> {
    // Re-read env in case it changed. `configure()` is usually called with persisted config only.
    if (!this.apiKey) this.apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    this.impl = new ChatClaudeProvider(this.apiKey, this.defaultModel);
    this.lastError = this.impl.available() ? undefined : "No API key configured";
  }


  async stop(): Promise<void> {
    this.impl = null;
  }

  isReady(): boolean {
    return this.impl?.available() ?? false;
  }

  getStatus(): LlmProviderStatus {
    return {
      slug: this.slug,
      name: this.name,
      ready: this.isReady(),
      capabilities: this.capabilities,
      lastModel: this.lastModel,
      error: this.lastError,
    };
  }

  getConfigSchema(): ConfigField[] {
    return [
      { key: "apiKey", label: "API key", type: "password", required: true, placeholder: "sk-ant-api03-…" },
      { key: "defaultModel", label: "Default model", type: "text", required: false, placeholder: "claude-sonnet-4-20250514" },
    ];
  }

  /** Discover Claude models via Anthropic's /v1/models. Uses x-api-key header (not Bearer). */
  async listModels(): Promise<string[]> {
    if (!this.apiKey) return [];
    // Errors propagate on purpose: both consumers handle throws (the /models
    // route surfaces `error` to the UI so the setup wizard can say "invalid
    // key" vs "no network"; discovery skips the provider). Swallowing them
    // here made auth failures indistinguishable from an empty catalog.
    const r = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await r.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? "").filter(Boolean).sort();
  }

  async chatCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    if (!this.impl) throw new Error("Claude provider not started");
    // The old adapter's types and the new contract's types are close but not
    // identical — mapped 1:1 where applicable. The adapter's ChatMessage accepts
    // `content: string | ContentBlock[]` y tools en shape Anthropic.
    const result = await this.impl.chatCompletion(
      messages as unknown as Parameters<ChatClaudeProvider["chatCompletion"]>[0],
      opts as unknown as Parameters<ChatClaudeProvider["chatCompletion"]>[1],
    );
    this.lastModel = result.model;
    return {
      content: result.content,
      model: result.model,
      stop_reason: result.stop_reason,
      tool_calls: result.tool_calls?.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
      usage: {
        input_tokens: 0, // el adapter consolida a `tokens_used`, no expone breakdown
        output_tokens: result.tokens_used,
      },
    };
  }
}

export const createClaudeProvider = (): LlmProvider => new ClaudeProviderImpl();

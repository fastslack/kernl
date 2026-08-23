/**
 * Built-in LLM provider — xAI Grok.
 * Wrapper sobre ChatGrokProvider (OpenAI-compatible endpoint en api.x.ai).
 */

import { ChatGrokProvider } from "../chat-adapters.js";
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
  streaming: false,
  thinking: true,
  vision: false,
  promptCaching: false,
  contextWindow: 256_000,
};

class GrokProviderImpl implements LlmProvider {
  readonly slug = "grok";
  readonly name = "xAI Grok";
  readonly capabilities = CAPS;

  private impl: ChatGrokProvider | null = null;
  private apiKey = "";
  private defaultModel = "grok-4-fast-non-reasoning";
  private lastError?: string;
  private lastModel?: string;

  configure(config: Record<string, unknown>): void {
    this.apiKey = typeof config.apiKey === "string" && config.apiKey
      ? config.apiKey
      : (process.env.GROK_API_KEY ?? "");
    if (typeof config.defaultModel === "string" && config.defaultModel) this.defaultModel = config.defaultModel;
  }

  async start(): Promise<void> {
    if (!this.apiKey) this.apiKey = process.env.GROK_API_KEY ?? "";
    this.impl = new ChatGrokProvider(this.apiKey, undefined, this.defaultModel);
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
      { key: "apiKey", label: "API key", type: "password", required: true, placeholder: "xai-…" },
      { key: "defaultModel", label: "Default model", type: "text", required: false, placeholder: "grok-4-fast-non-reasoning" },
    ];
  }

  /**
   * Discover Grok chat models. xAI's `/v1/models` returns ALL models (chat,
   * image-generation, embeddings, etc) — invoking an image model on the
   * chat-completions endpoint returns 400 "Model not found". Use the
   * dedicated `/v1/language-models` endpoint, which only lists models that
   * accept text→text on chat completions.
   */
  async listModels(): Promise<string[]> {
    if (!this.apiKey) return [];
    // Errors propagate on purpose — see claude-provider.listModels. Both
    // consumers handle throws; swallowing turned a dead key into a green
    // "ready" pill with an empty model dropdown on the settings page.
    const r = await fetch("https://api.x.ai/v1/language-models", {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await r.json()) as {
      models?: Array<{
        id?: string;
        input_modalities?: string[];
        output_modalities?: string[];
      }>;
    };
    return (body.models ?? [])
      .filter((m) => (m.output_modalities ?? []).includes("text"))
      .map((m) => m.id ?? "")
      .filter(Boolean)
      .sort();
  }

  async chatCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    if (!this.impl) throw new Error("Grok provider not started");
    const result = await this.impl.chatCompletion(
      messages as unknown as Parameters<ChatGrokProvider["chatCompletion"]>[0],
      opts as unknown as Parameters<ChatGrokProvider["chatCompletion"]>[1],
    );
    this.lastModel = result.model;
    return {
      content: result.content,
      model: result.model,
      stop_reason: result.stop_reason,
      tool_calls: result.tool_calls?.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
      usage: { input_tokens: 0, output_tokens: result.tokens_used },
    };
  }
}

export const createGrokProvider = (): LlmProvider => new GrokProviderImpl();

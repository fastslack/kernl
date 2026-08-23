/**
 * Built-in LLM provider — OpenAI.
 * Wrapper over the existing adapter's ChatOpenAiProvider.
 */

import { ChatOpenAiProvider } from "../chat-adapters.js";
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
  thinking: false,
  vision: true,
  promptCaching: false,
  contextWindow: 128_000,
};

class OpenAiProviderImpl implements LlmProvider {
  readonly slug = "openai";
  readonly name = "OpenAI";
  readonly capabilities = CAPS;

  protected impl: ChatOpenAiProvider | null = null;
  protected apiKey = "";
  protected baseUrl = "https://api.openai.com/v1";
  protected defaultModel = "gpt-4o-mini";
  protected lastError?: string;
  protected lastModel?: string;

  configure(config: Record<string, unknown>): void {
    this.apiKey = typeof config.apiKey === "string" && config.apiKey
      ? config.apiKey
      : (process.env.OPENAI_API_KEY ?? "");
    if (typeof config.baseUrl === "string" && config.baseUrl) this.baseUrl = config.baseUrl;
    if (typeof config.defaultModel === "string" && config.defaultModel) this.defaultModel = config.defaultModel;
  }

  async start(): Promise<void> {
    if (!this.apiKey) this.apiKey = process.env.OPENAI_API_KEY ?? "";
    this.impl = new ChatOpenAiProvider(this.apiKey, this.baseUrl, this.defaultModel);
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
      { key: "apiKey", label: "API key", type: "password", required: true, placeholder: "sk-proj-…" },
      { key: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://api.openai.com/v1" },
      { key: "defaultModel", label: "Default model", type: "text", required: false, placeholder: "gpt-4o-mini" },
    ];
  }

  /** Discover models via OpenAI's /v1/models. Filters to chat-capable ids (gpt-*, o1-*, o3-*). */
  async listModels(): Promise<string[]> {
    if (!this.apiKey) return [];
    // Errors propagate on purpose — see claude-provider.listModels. Both
    // consumers handle throws; swallowing hid auth failures from the wizard.
    const url = `${this.baseUrl.replace(/\/+$/, "")}/models`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await r.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    // OpenAI returns embeddings/whisper/etc. mixed in — filter to chat models.
    return ids.filter((id) => /^(gpt-|o1-|o3-|chatgpt-)/i.test(id)).sort();
  }

  async chatCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    if (!this.impl) throw new Error("OpenAI provider not started");
    const result = await this.impl.chatCompletion(
      messages as unknown as Parameters<ChatOpenAiProvider["chatCompletion"]>[0],
      opts as unknown as Parameters<ChatOpenAiProvider["chatCompletion"]>[1],
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

export const createOpenAiProvider = (): LlmProvider => new OpenAiProviderImpl();

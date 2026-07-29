/**
 * Built-in LLM provider — MiniMax (OpenAI-compatible).
 * Reuses ChatOpenAiProvider pointed at MiniMax's international endpoint.
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
  vision: false,
  promptCaching: false,
  contextWindow: 200_000,
};

const DEFAULT_BASE = "https://api.minimax.io/v1";
const DEFAULT_MODEL = "MiniMax-M2.7";

class MinimaxProviderImpl implements LlmProvider {
  readonly slug = "minimax";
  readonly name = "MiniMax";
  readonly capabilities = CAPS;

  private impl: ChatOpenAiProvider | null = null;
  private apiKey = "";
  private baseUrl = DEFAULT_BASE;
  private defaultModel = DEFAULT_MODEL;
  private lastError?: string;
  private lastModel?: string;

  configure(config: Record<string, unknown>): void {
    this.apiKey = typeof config.apiKey === "string" && config.apiKey
      ? config.apiKey
      : (process.env.MINIMAX_API_KEY ?? "");
    if (typeof config.baseUrl === "string" && config.baseUrl) this.baseUrl = config.baseUrl;
    else if (process.env.MINIMAX_BASE_URL) this.baseUrl = process.env.MINIMAX_BASE_URL;
    if (typeof config.defaultModel === "string" && config.defaultModel) this.defaultModel = config.defaultModel;
    else if (process.env.MINIMAX_DEFAULT_MODEL) this.defaultModel = process.env.MINIMAX_DEFAULT_MODEL;
  }

  async start(): Promise<void> {
    if (!this.apiKey) this.apiKey = process.env.MINIMAX_API_KEY ?? "";
    this.impl = new ChatOpenAiProvider(this.apiKey, this.baseUrl, this.defaultModel, "minimax");
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
      { key: "apiKey", label: "API key", type: "password", required: true, placeholder: "eyJ…" },
      { key: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: DEFAULT_BASE },
      { key: "defaultModel", label: "Default model", type: "text", required: false, placeholder: DEFAULT_MODEL },
    ];
  }

  /** MiniMax exposes an OpenAI-compatible /v1/models. */
  async listModels(): Promise<string[]> {
    if (!this.apiKey) return [];
    // Errors propagate on purpose — see claude-provider.listModels. Both
    // consumers handle throws; swallowing turned a dead key into a green
    // "ready" pill with an empty model dropdown on the settings page.
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
    return (body.data ?? []).map((m) => m.id ?? "").filter(Boolean).sort();
  }

  async chatCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    if (!this.impl) throw new Error("MiniMax provider not started");
    const result = await this.impl.chatCompletion(
      messages as unknown as Parameters<ChatOpenAiProvider["chatCompletion"]>[0],
      opts as unknown as Parameters<ChatOpenAiProvider["chatCompletion"]>[1],
    );
    this.lastModel = result.model;
    return {
      content: result.content,
      model: result.model,
      stop_reason: result.stop_reason,
      tool_calls: result.tool_calls?.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input })),
      usage: { input_tokens: 0, output_tokens: result.tokens_used },
    };
  }
}

export const createMinimaxProvider = (): LlmProvider => new MinimaxProviderImpl();

/**
 * Built-in LLM provider — NVIDIA NIM.
 * Wrapper sobre ChatNvidiaProvider (OpenAI-compatible endpoint en
 * integrate.api.nvidia.com/v1). NIM hostea DeepSeek, Llama, Mistral y otros.
 */

import { ChatNvidiaProvider, NVIDIA_DEFAULT_MODEL } from "../chat-adapters.js";
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
  contextWindow: 128_000,
};

class NvidiaProviderImpl implements LlmProvider {
  readonly slug = "nvidia";
  readonly name = "NVIDIA NIM";
  readonly capabilities = CAPS;

  private impl: ChatNvidiaProvider | null = null;
  private apiKey = "";
  private defaultModel = NVIDIA_DEFAULT_MODEL;
  private lastError?: string;
  private lastModel?: string;

  configure(config: Record<string, unknown>): void {
    this.apiKey = typeof config.apiKey === "string" && config.apiKey
      ? config.apiKey
      : (process.env.NVIDIA_API_KEY ?? "");
    if (typeof config.defaultModel === "string" && config.defaultModel) this.defaultModel = config.defaultModel;
  }

  async start(): Promise<void> {
    if (!this.apiKey) this.apiKey = process.env.NVIDIA_API_KEY ?? "";
    this.impl = new ChatNvidiaProvider(this.apiKey, undefined, this.defaultModel);
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
      { key: "apiKey", label: "API key", type: "password", required: true, placeholder: "nvapi-…" },
      { key: "defaultModel", label: "Default model", type: "text", required: false, placeholder: NVIDIA_DEFAULT_MODEL },
    ];
  }

  /**
   * Descubre modelos disponibles en NVIDIA NIM via /v1/models. Devuelve la lista
   * cruda; la UI puede filtrarla. Sin key devuelve []; si la request falla,
   * lanza (los consumidores distinguen "no configurado" de "key rota").
   */
  async listModels(): Promise<string[]> {
    if (!this.apiKey) return [];
    // Errors propagate on purpose — see claude-provider.listModels. Both
    // consumers handle throws; swallowing turned a dead key into a green
    // "ready" pill with an empty model dropdown on the settings page.
    const r = await fetch("https://integrate.api.nvidia.com/v1/models", {
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
    if (!this.impl) throw new Error("NVIDIA provider not started");
    const result = await this.impl.chatCompletion(
      messages as unknown as Parameters<ChatNvidiaProvider["chatCompletion"]>[0],
      opts as unknown as Parameters<ChatNvidiaProvider["chatCompletion"]>[1],
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

export const createNvidiaProvider = (): LlmProvider => new NvidiaProviderImpl();

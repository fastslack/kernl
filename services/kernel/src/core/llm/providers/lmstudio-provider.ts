/**
 * Built-in LLM provider — LM Studio (local, OpenAI-compat).
 * Wrapper sobre ChatLmStudioProvider. Apunta a un server local.
 */

import { ChatLmStudioProvider } from "../chat-adapters.js";
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
  contextWindow: 32_000, // depende del modelo cargado, 32k es conservador
};

class LmStudioProviderImpl implements LlmProvider {
  readonly slug = "lmstudio";
  readonly name = "LM Studio (local)";
  readonly capabilities = CAPS;

  private impl: ChatLmStudioProvider | null = null;
  private baseUrl = "http://localhost:1234/v1";
  private lastError?: string;
  private lastModel?: string;

  configure(config: Record<string, unknown>): void {
    if (typeof config.baseUrl === "string" && config.baseUrl) {
      this.baseUrl = config.baseUrl;
    } else if (process.env.LMSTUDIO_BASE_URL) {
      this.baseUrl = process.env.LMSTUDIO_BASE_URL;
    }
  }

  async start(): Promise<void> {
    if (!this.baseUrl) this.baseUrl = process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";
    this.impl = new ChatLmStudioProvider(this.baseUrl);
    this.lastError = this.impl.available() ? undefined : "LM Studio not reachable at " + this.baseUrl;
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
      { key: "baseUrl", label: "Base URL", type: "text", required: true, placeholder: "http://localhost:1234/v1" },
    ];
  }

  /** Discover models loaded in the local LM Studio instance via /v1/models (no auth). */
  async listModels(): Promise<string[]> {
    if (!this.baseUrl) return [];
    // Errors propagate on purpose — see claude-provider.listModels. Lets the
    // setup wizard distinguish "LM Studio not running" from "no models loaded".
    const url = `${this.baseUrl.replace(/\/+$/, "")}/models`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
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
    if (!this.impl) throw new Error("LM Studio provider not started");
    const result = await this.impl.chatCompletion(
      messages as unknown as Parameters<ChatLmStudioProvider["chatCompletion"]>[0],
      opts as unknown as Parameters<ChatLmStudioProvider["chatCompletion"]>[1],
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

export const createLmStudioProvider = (): LlmProvider => new LmStudioProviderImpl();

/**
 * Built-in LLM provider — LM Studio (local, OpenAI-compat).
 * Wrapper sobre ChatLmStudioProvider. Apunta a un server local.
 */

import { ChatLmStudioProvider } from "../chat-adapters.js";
import { log } from "../../logger.js";
import {
  LMSTUDIO_DEFAULT_BASE,
  detectLmStudio,
  normalizeLmStudioBase,
} from "../lmstudio-detect.js";

export { LMSTUDIO_DEFAULT_BASE, detectLmStudio, normalizeLmStudioBase };
export type { LmStudioDetection, LmStudioModel } from "../lmstudio-detect.js";
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
  /** Model resolved from LM Studio at start, used when the caller names none. */
  private detected?: string;

  configure(config: Record<string, unknown>): void {
    if (typeof config.baseUrl === "string" && config.baseUrl) {
      this.baseUrl = normalizeLmStudioBase(config.baseUrl);
    } else if (process.env.LMSTUDIO_BASE_URL) {
      this.baseUrl = normalizeLmStudioBase(process.env.LMSTUDIO_BASE_URL);
    }
  }

  async start(): Promise<void> {
    this.baseUrl = normalizeLmStudioBase(
      this.baseUrl || process.env.LMSTUDIO_BASE_URL || LMSTUDIO_DEFAULT_BASE,
    );
    const found = await detectLmStudio(this.baseUrl);

    // Nothing at the configured address? Try the default before giving up.
    // Someone who mistyped the port once should not have a dead provider
    // forever while LM Studio sits listening where it always does.
    if (!found.running && this.baseUrl !== LMSTUDIO_DEFAULT_BASE) {
      const fallback = await detectLmStudio(LMSTUDIO_DEFAULT_BASE);
      if (fallback.running) {
        log.info(`LM Studio: nothing at ${this.baseUrl}, found it at ${LMSTUDIO_DEFAULT_BASE} — using that`);
        this.baseUrl = fallback.baseUrl;
        Object.assign(found, fallback);
      }
    }

    // Resolve the model here so the adapter never has to invent one.
    this.detected = found.activeModel ?? undefined;
    this.impl = new ChatLmStudioProvider(this.baseUrl, this.detected ?? "");

    // Three distinct failures, three distinct messages. A flat "not reachable"
    // sent people hunting for a firewall while LM Studio ran the whole time
    // with nothing loaded in it.
    if (!found.running) {
      this.lastError = `LM Studio is not answering at ${this.baseUrl} — is the local server started?`;
    } else if (!this.detected) {
      const why = found.models.length === 0 ? "no models downloaded" : "no chat-capable model available";
      this.lastError = `LM Studio is running at ${this.baseUrl} but ${why}.`;
    } else {
      this.lastError = undefined;
      const loaded = found.models.filter((m) => m.loaded).length;
      log.info(
        `LM Studio detected at ${this.baseUrl} — using "${this.detected}" ` +
          `(${loaded} loaded of ${found.models.length} downloaded)`,
      );
    }
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
      lastModel: this.lastModel ?? this.detected,
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
    const url = `${normalizeLmStudioBase(this.baseUrl)}/models`;
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

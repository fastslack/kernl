/**
 * Registry provider for every OpenAI-compatible entry in the catalog.
 *
 * openai, grok, nvidia and minimax were four near-identical files that only
 * differed in a URL, a key prefix and a default model — which is how their
 * defaults drifted apart. The differences now live in the catalog and this one
 * class serves them all, plus ollama, openrouter, gemini, deepseek and groq.
 */

import { buildChatAdapter, type ChatLlmProvider } from "../chat-adapters.js";
import { getCatalogEntry, modelsUrl, type ProviderCatalogEntry } from "../provider-catalog.js";
import { resolveProviderConfig, type ProviderConfig } from "../credentials.js";
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
  contextWindow: 128_000,
};

class CatalogOpenAiProvider implements LlmProvider {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: LlmProviderCapabilities;

  private cfg: ProviderConfig;
  private impl: ChatLlmProvider | null = null;
  private lastError?: string;
  private lastModel?: string;

  constructor(private entry: ProviderCatalogEntry) {
    this.slug = entry.slug;
    this.name = entry.name;
    // Most catalog entries share the generic defaults; a few override
    // thinking/vision/contextWindow with what they actually support.
    this.capabilities = { ...CAPS, ...entry.capabilities };
    this.cfg = resolveProviderConfig(entry, {});
  }

  configure(config: Record<string, unknown>): void {
    this.cfg = resolveProviderConfig(this.entry, config);
  }

  async start(): Promise<void> {
    this.impl = buildChatAdapter(this.entry.slug, this.cfg);
    this.lastError = this.isReady() ? undefined : "No API key configured";
  }

  async stop(): Promise<void> {
    this.impl = null;
  }

  isReady(): boolean {
    if (!this.impl?.available()) return false;
    return !this.entry.needsKey || this.cfg.apiKey !== "";
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
    const fields: ConfigField[] = [];
    if (this.entry.needsKey) fields.push({ key: "apiKey", label: "API key", type: "password", required: true });
    if (this.entry.baseUrlEditable) {
      fields.push({ key: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: this.entry.baseUrl });
    }
    fields.push({ key: "defaultModel", label: "Default model", type: "text", required: false, placeholder: this.entry.models.recommended ?? "" });
    if (this.entry.regions) {
      fields.push({ key: "region", label: "Region", type: "text", required: false, placeholder: this.entry.regions[0].id });
    }
    return fields;
  }

  /** Errors propagate: a 401 must not look like an empty catalogue. */
  async listModels(): Promise<string[]> {
    if (this.entry.needsKey && !this.cfg.apiKey) return [];
    const headers: Record<string, string> = {};
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    const r = await fetch(modelsUrl(this.cfg.baseUrl), { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await r.json()) as { data?: Array<{ id?: string }> };
    // Gemini's compatible endpoint returns "models/<id>" but only accepts "<id>".
    return (body.data ?? [])
      .map((m) => (m.id ?? "").replace(/^models\//, ""))
      .filter(Boolean)
      .sort();
  }

  async chatCompletion(messages: ChatMessage[], opts?: ChatCompletionOptions): Promise<ChatCompletionResult> {
    if (!this.impl) throw new Error(`${this.name} provider not started`);
    const result = await this.impl.chatCompletion(
      messages as unknown as Parameters<ChatLlmProvider["chatCompletion"]>[0],
      opts as unknown as Parameters<ChatLlmProvider["chatCompletion"]>[1],
    );
    this.lastModel = result.model;
    return {
      content: result.content,
      model: result.model,
      stop_reason: result.stop_reason,
      tool_calls: result.tool_calls?.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input })),
      usage: { input_tokens: result.input_tokens ?? 0, output_tokens: result.output_tokens ?? result.tokens_used },
    };
  }
}

export function createCatalogProvider(slug: string): () => LlmProvider {
  const entry = getCatalogEntry(slug);
  if (!entry || entry.kind !== "openai-compatible") {
    throw new Error(`"${slug}" is not an OpenAI-compatible catalog provider`);
  }
  return () => new CatalogOpenAiProvider(entry);
}

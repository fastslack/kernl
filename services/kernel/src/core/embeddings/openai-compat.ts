/**
 * Generic OpenAI-compatible embeddings client. Works for any backend that
 * exposes `POST {baseUrl}/embeddings` with the OpenAI request/response shape:
 *
 *   request:  { model, input: string | string[] }
 *   response: { data: [{ embedding: number[], index: number }, ...], model, ... }
 *
 * Used as a single implementation for LM Studio, OpenAI, NVIDIA NIM, and
 * Ollama (when running its OpenAI-compatible endpoint). Each instance is
 * pinned to one (model, dim) — the chain wrapper decides between them.
 */

import type { EmbedOptions, EmbeddingsClient, EmbeddingsProvider } from "./client.js";

interface OpenAIEmbeddingsResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

interface OpenAIModelsResponse {
  data: Array<{ id: string; object?: string }>;
}

export interface OpenAiCompatOptions {
  /** Logical slug used for logging + index-name suffix when multiple providers serve the same model. */
  provider: EmbeddingsProvider;
  /** Base URL — must include /v1. Examples:
   *   - LM Studio: http://127.0.0.1:1234/v1
   *   - OpenAI:    https://api.openai.com/v1
   *   - NVIDIA NIM: https://integrate.api.nvidia.com/v1
   *   - Ollama:    http://127.0.0.1:11434/v1
   */
  baseUrl: string;
  /** Model id sent in the `model` field of the request body. */
  model: string;
  /** Vector dimension — must match what the endpoint actually returns. */
  dim: number;
  /** Optional bearer token. LM Studio/Ollama ignore auth so omit for those. */
  apiKey?: string;
  /** Extra payload fields to merge into every embed request. NVIDIA, e.g.,
   *  wants `input_type: "passage"` for retrieval-tuned models. */
  extraBody?: Record<string, unknown>;
  /** Timeout for the probe call (ms). Defaults to 3000. */
  probeTimeoutMs?: number;
  /** Timeout for the embed call (ms). Defaults to 30000 — embedding a
   *  full 32-row batch on a small model can take ~10s. */
  embedTimeoutMs?: number;
}

export class OpenAiCompatEmbeddings implements EmbeddingsClient {
  readonly provider: EmbeddingsProvider;
  readonly model: string;
  readonly dim: number;
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly extraBody: Record<string, unknown>;
  private readonly probeTimeoutMs: number;
  private readonly embedTimeoutMs: number;

  constructor(opts: OpenAiCompatOptions) {
    this.provider = opts.provider;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.dim = opts.dim;
    this.apiKey = opts.apiKey ?? "";
    this.extraBody = opts.extraBody ?? {};
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 3000;
    this.embedTimeoutMs = opts.embedTimeoutMs ?? 30_000;
  }

  /** Probe: hit /models and check the configured `model` is in the catalog.
   *  Some providers (NVIDIA) gate /models behind auth and may 401 on missing
   *  keys — that's "unavailable" for our purposes. OpenAI's /models lists
   *  hundreds of models so the substring check is exact-id. */
  async available(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
      const r = await fetch(`${this.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      });
      if (!r.ok) return false;
      const body = (await r.json()) as OpenAIModelsResponse;
      if (!Array.isArray(body.data)) return false;
      // Match by exact id. Providers vary: OpenAI uses bare ids
      // ("text-embedding-3-small"), NVIDIA uses namespaced
      // ("nvidia/nv-embedqa-e5-v5"). We don't normalize — exact match avoids
      // accidentally claiming availability for a similar-but-different model.
      return body.data.some((m) => m.id === this.model);
    } catch {
      return false;
    }
  }

  async embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    // Asymmetric encoders (NVIDIA NIM's nv-embedqa-* family, BGE retrieval,
    // E5) ship two prefixes. The factory configures `extraBody.input_type =
    // "passage"` so document-side indexing is correct by default. At search
    // time the caller passes `inputType: "query"` and we override that
    // single field — leaving any other extraBody keys untouched.
    const extra = opts?.inputType
      ? { ...this.extraBody, input_type: opts.inputType }
      : this.extraBody;
    const body = { model: this.model, input: texts, ...extra };
    const r = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.embedTimeoutMs),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(
        `embeddings ${this.provider} ${r.status} ${r.statusText} — ${txt.slice(0, 240)}`,
      );
    }
    const payload = (await r.json()) as OpenAIEmbeddingsResponse;
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      throw new Error(
        `embeddings ${this.provider} response shape mismatch: expected ${texts.length} items, got ${payload.data?.length ?? 0}`,
      );
    }
    // OpenAI spec doesn't guarantee response order — sort by index before mapping.
    return payload.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

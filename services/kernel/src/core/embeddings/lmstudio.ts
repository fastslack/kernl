/**
 * LMStudio embeddings backend — OpenAI-compatible /v1/embeddings endpoint.
 *
 * LMStudio runs locally (default http://127.0.0.1:1234/v1) and serves any
 * GGUF embedding model the user loaded. We trust the configured `dim`
 * rather than re-reading it on every call; the factory verifies once at
 * boot and any drift after that means the user changed the loaded model
 * — caller catches the dim mismatch on first write to Neo4j.
 */

import type { EmbedOptions, EmbeddingsClient } from "./client.js";

interface OpenAIEmbeddingsResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

interface OpenAIModelsResponse {
  data: Array<{ id: string; object?: string }>;
}

export class LmStudioEmbeddings implements EmbeddingsClient {
  readonly provider = "lmstudio" as const;

  constructor(
    /** Base URL incl. /v1 — `http://127.0.0.1:1234/v1`. */
    public readonly baseUrl: string,
    public readonly model: string,
    public readonly dim: number,
  ) {}

  async available(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return false;
      const body = (await r.json()) as OpenAIModelsResponse;
      return Array.isArray(body.data) && body.data.some((m) => m.id === this.model);
    } catch {
      return false;
    }
  }

  async embed(texts: string[], _opts?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    const r = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`embeddings ${r.status} ${r.statusText} — ${txt.slice(0, 240)}`);
    }
    const body = (await r.json()) as OpenAIEmbeddingsResponse;
    if (!Array.isArray(body.data) || body.data.length !== texts.length) {
      throw new Error(`embeddings response shape mismatch: expected ${texts.length} items, got ${body.data?.length ?? 0}`);
    }
    // OpenAI spec doesn't guarantee response order, sort by index.
    return body.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

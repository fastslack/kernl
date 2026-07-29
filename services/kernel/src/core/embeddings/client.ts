/**
 * Generic embeddings client interface. Backends:
 *   - lmstudio: OpenAI-compatible /v1/embeddings (local LM Studio server)
 *   - openai:   OpenAI's /v1/embeddings
 *   - nvidia:   NVIDIA NIM's /v1/embeddings
 *   - ollama:   Ollama's OpenAI-compatible /v1/embeddings
 *   - local:    in-process @huggingface/transformers (MiniLM, absolute fallback)
 *   - chain:    wraps multiple of the above and walks them in order on failure
 *
 * Why generic: the cinema module needs vectors but so do graph-intel,
 * chat knowledge, future RAG, etc. Centralising it means the user picks
 * one model + provider and every consumer follows.
 */

export type EmbeddingsProvider =
  | "lmstudio"
  | "openai"
  | "nvidia"
  | "ollama"
  | "local"
  | "chain";

/** Per-call hints. Asymmetric encoders (E5/BGE/NVIDIA NIM retrieval models)
 *  need different prefixes for the document side ("passage") and the search
 *  side ("query"). Symmetric/general-purpose models ignore this. Default
 *  is "passage" to preserve the existing indexing behavior — callers doing
 *  search-time encoding must opt-in with `inputType: "query"`. */
export interface EmbedOptions {
  inputType?: "query" | "passage";
}

export interface EmbeddingsClient {
  /** Provider id, for logging. */
  readonly provider: EmbeddingsProvider;
  /** Model identifier — passed to the LMStudio API or HF model name. */
  readonly model: string;
  /** Vector dimension. Used to size Neo4j vector indexes. */
  readonly dim: number;

  /** Probe whether the backend is reachable + the configured model is loaded. */
  available(): Promise<boolean>;

  /**
   * Embed N input strings, return N vectors in the SAME order as `texts`.
   * Throws on transport/model error — no silent partial results.
   */
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}

/**
 * Sanitize a model id for use in identifier-only contexts (Neo4j vector
 * index name, file paths). Lowercase, alnum + dashes only, capped at 40
 * chars so the index name stays readable.
 */
export function safeIndexSuffix(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

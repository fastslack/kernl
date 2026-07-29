/**
 * Local fallback embeddings — @huggingface/transformers running in-process.
 * Used when LMStudio isn't reachable. Mirrors the model already used by
 * graph-intel/embeddings.ts (Xenova/all-MiniLM-L6-v2, 384 dim) so swapping
 * back doesn't require re-embedding existing graphs.
 *
 * Cold-start: ~3-5s on first call (downloads ONNX model from HF if missing,
 * caches under HF_HOME). Subsequent calls reuse the loaded pipeline.
 */

import { log } from "../logger.js";
import type { EmbedOptions, EmbeddingsClient } from "./client.js";

const FALLBACK_MODEL = "Xenova/all-MiniLM-L6-v2";
const FALLBACK_DIM = 384;

type FeaturePipeline = (
  texts: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let pipelinePromise: Promise<FeaturePipeline> | null = null;

async function loadPipeline(): Promise<FeaturePipeline> {
  if (!pipelinePromise) {
    log.info(`embeddings/local: loading ${FALLBACK_MODEL} …`);
    pipelinePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("feature-extraction", FALLBACK_MODEL, {
        dtype: "fp32",
      })) as unknown as FeaturePipeline;
    })();
  }
  return pipelinePromise;
}

export class LocalEmbeddings implements EmbeddingsClient {
  readonly provider = "local" as const;
  readonly model = FALLBACK_MODEL;
  readonly dim = FALLBACK_DIM;

  async available(): Promise<boolean> {
    // The HF model auto-downloads on first use; treat the backend as always
    // available. If the download fails the error surfaces from `embed()`.
    return true;
  }

  async embed(texts: string[], _opts?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    const p = await loadPipeline();
    const result = await p(texts, { pooling: "mean", normalize: true });
    const list = result.tolist();
    if (list.length !== texts.length) {
      throw new Error(`local embeddings shape mismatch: expected ${texts.length}, got ${list.length}`);
    }
    return list;
  }
}

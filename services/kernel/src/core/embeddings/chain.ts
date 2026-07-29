/**
 * ChainedEmbeddings — primary + fallback wrapper, modelled on the LLM
 * client's chain (`src/core/llm/client.ts`). Tries each link in order on
 * embed() failure; the first one that returns successfully wins.
 *
 * Invariants:
 *  - The chain has a single declared (model, dim) — taken from the primary.
 *  - Fallback links whose (model, dim) don't match the primary are SKIPPED
 *    at construction time and logged with a clear warning. Reason: writing
 *    vectors of a different shape would corrupt the Neo4j index that is
 *    keyed by `safeIndexSuffix(model)` and sized to `dim`. Silent shape
 *    drift = catastrophic for semantic search.
 *  - The chained client itself reports the primary's (provider, model, dim)
 *    — this is what callers use for index naming and reembed bookkeeping.
 *
 * The chain is FAIL-LOUD when every link errors. The caller (cinema embed
 * worker, graph-intel, etc.) is responsible for skipping the batch or
 * surfacing the error — we never silently downgrade to a different model
 * because that would silently break the index.
 */

import { log } from "../logger.js";
import type { EmbedOptions, EmbeddingsClient, EmbeddingsProvider } from "./client.js";

export class ChainedEmbeddings implements EmbeddingsClient {
  readonly provider: EmbeddingsProvider = "chain";
  readonly model: string;
  readonly dim: number;
  /** The actual underlying provider that last served a successful embed(). */
  private activeProvider: string;
  private readonly links: EmbeddingsClient[];

  constructor(primary: EmbeddingsClient, fallbacks: EmbeddingsClient[] = []) {
    this.model = primary.model;
    this.dim = primary.dim;
    this.activeProvider = primary.provider;

    // Filter fallbacks to those with matching (model, dim). The match is
    // EXACT — different model names mean different embedding spaces even
    // when dim coincides, so we don't pretend.
    const compatible: EmbeddingsClient[] = [];
    for (const f of fallbacks) {
      if (f.model === primary.model && f.dim === primary.dim) {
        compatible.push(f);
      } else {
        log.warn(
          `embeddings chain: skipping fallback ${f.provider} (model=${f.model} dim=${f.dim}) — ` +
          `incompatible with primary ${primary.provider} (model=${primary.model} dim=${primary.dim})`,
        );
      }
    }
    this.links = [primary, ...compatible];
  }

  /** Snapshot of which link last served a successful embed(). Useful for
   *  /api/cinema/ingest/status and similar surface-level diagnostics. */
  getActiveProvider(): string {
    return this.activeProvider;
  }

  /** Snapshot of the configured chain — for diagnostics endpoints. */
  describe(): Array<{ provider: string; model: string; dim: number }> {
    return this.links.map((l) => ({ provider: l.provider, model: l.model, dim: l.dim }));
  }

  /** True if ANY link is reachable. Cached against staleness only at the
   *  call site — we don't memoize because callers (the cinema embed worker)
   *  probe at boot once, then trust embed() to surface errors. */
  async available(): Promise<boolean> {
    for (const l of this.links) {
      try {
        if (await l.available()) return true;
      } catch { /* probe error == unavailable, keep going */ }
    }
    return false;
  }

  async embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    let lastErr: unknown;
    for (let i = 0; i < this.links.length; i++) {
      const link = this.links[i];
      try {
        const out = await link.embed(texts, opts);
        if (this.activeProvider !== link.provider) {
          // Surface the switch ONCE per transition so logs stay readable
          // when the chain is healthy.
          log.info(
            `embeddings chain: active link is now ${link.provider} ` +
            `(previous ${this.activeProvider}; chain depth ${i + 1}/${this.links.length})`,
          );
          this.activeProvider = link.provider;
        }
        return out;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (i < this.links.length - 1) {
          log.warn(
            `embeddings chain: ${link.provider} failed (${msg.slice(0, 160)}) — trying next link`,
          );
        }
      }
    }
    // All links exhausted. Re-throw the last error so the caller can decide
    // what to do (skip the batch, surface to the UI, etc.).
    throw lastErr instanceof Error
      ? lastErr
      : new Error("embeddings chain: every link failed (no specific error captured)");
  }
}

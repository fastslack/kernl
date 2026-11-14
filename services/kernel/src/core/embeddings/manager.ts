/**
 * EmbeddingsManager — the one embeddings client the kernel hands out.
 *
 * Consumers (agents, tool-memory, cinema, rss-registry, brain, …) receive
 * this object once at boot and keep it. It delegates every call to the
 * client the factory built, and can swap that client while the kernel runs:
 *
 *  - when the user changes an EMBEDDINGS_* setting in /models;
 *  - when the auto chain fell back to the in-process model because every
 *    /models link was down, and a link comes back (re-probed every
 *    `reprobeMs`).
 *
 * `model` and `dim` are read through, so a consumer that tags rows with
 * `client.model` (AgentService, cinema) follows the swap on its next write.
 * After a swap — and once at start — the re-embed queue converts the rows
 * that still carry another model's vectors (reembed.ts).
 */

import { log } from "../logger.js";
import type { EmbedOptions, EmbeddingsClient, EmbeddingsProvider } from "./client.js";
import { ChainedEmbeddings } from "./chain.js";
import { LocalEmbeddings, sharedLocalEmbeddings, type LocalEmbeddingsStatus } from "./local.js";
import type { ReembedQueue, ReembedStatus } from "./reembed.js";

export interface EmbeddingsStatus {
  provider: EmbeddingsProvider;
  model: string;
  dim: number;
  /** The link serving calls right now (differs from `provider` for a chain). */
  activeProvider: string;
  /** The auto chain's last resort is serving: a /models link is being waited for. */
  lastResort: boolean;
  /** Present when the in-process model is (or backs) the active client. */
  local: LocalEmbeddingsStatus | null;
  reembed: ReembedStatus | null;
}

export interface EmbeddingsManagerOptions {
  build: () => Promise<EmbeddingsClient>;
  isLastResort?: (c: EmbeddingsClient) => boolean;
  reprobeMs?: number;
  /** Delay before the first re-embed run, so boot is not slowed by it. */
  reembedDelayMs?: number;
}

export class EmbeddingsManager implements EmbeddingsClient {
  private inner: EmbeddingsClient;
  private reembed: ReembedQueue | null = null;
  private reprobeTimer: ReturnType<typeof setInterval> | null = null;
  private reembedTimer: ReturnType<typeof setTimeout> | null = null;
  private rebuilding: Promise<boolean> | null = null;
  private readonly listeners = new Set<(c: EmbeddingsClient) => void>();

  private constructor(first: EmbeddingsClient, private readonly opts: EmbeddingsManagerOptions) {
    this.inner = first;
  }

  /** Build the first client. Rejects when the factory does (no client at all). */
  static async create(opts: EmbeddingsManagerOptions): Promise<EmbeddingsManager> {
    const m = new EmbeddingsManager(await opts.build(), opts);
    m.armReprobe();
    return m;
  }

  get provider(): EmbeddingsProvider { return this.inner.provider; }
  get model(): string { return this.inner.model; }
  get dim(): number { return this.inner.dim; }

  available(): Promise<boolean> { return this.inner.available(); }
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> { return this.inner.embed(texts, opts); }

  /** The client calls are delegated to right now. */
  current(): EmbeddingsClient { return this.inner; }

  /** Called after every swap with the new client. */
  onSwap(fn: (c: EmbeddingsClient) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Attach the re-embed queue and schedule its first run. */
  attachReembed(queue: ReembedQueue): void {
    this.reembed = queue;
    this.scheduleReembed(this.opts.reembedDelayMs ?? 20_000);
  }

  private scheduleReembed(delayMs: number): void {
    if (!this.reembed) return;
    if (this.reembedTimer) clearTimeout(this.reembedTimer);
    this.reembedTimer = setTimeout(() => {
      this.reembedTimer = null;
      this.reembed?.run().catch((err) =>
        log.warn(`embeddings: re-embed run failed — ${err instanceof Error ? err.message : String(err)}`),
      );
    }, delayMs);
    this.reembedTimer.unref?.();
  }

  private armReprobe(): void {
    const lastResort = this.opts.isLastResort?.(this.inner) ?? false;
    if (lastResort && !this.reprobeTimer) {
      const every = this.opts.reprobeMs ?? 5 * 60_000;
      this.reprobeTimer = setInterval(() => {
        void this.rebuild("re-probing /models embedding links");
      }, every);
      this.reprobeTimer.unref?.();
    } else if (!lastResort && this.reprobeTimer) {
      clearInterval(this.reprobeTimer);
      this.reprobeTimer = null;
    }
  }

  /**
   * Build a fresh client and swap to it when it differs from the current one
   * (another provider or model). Concurrent calls share one build.
   * Resolves true when a swap happened.
   */
  rebuild(reason: string): Promise<boolean> {
    if (!this.rebuilding) {
      this.rebuilding = this.doRebuild(reason).finally(() => { this.rebuilding = null; });
    }
    return this.rebuilding;
  }

  private async doRebuild(reason: string): Promise<boolean> {
    let next: EmbeddingsClient;
    try {
      next = await this.opts.build();
    } catch (err) {
      log.warn(`embeddings: rebuild (${reason}) failed — keeping ${this.inner.provider} ${this.inner.model}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    const prev = this.inner;
    const same = next.provider === prev.provider && next.model === prev.model && next.dim === prev.dim
      && (this.opts.isLastResort?.(next) ?? false) === (this.opts.isLastResort?.(prev) ?? false);
    if (same) {
      this.armReprobe();
      return false;
    }
    this.inner = next;
    log.info(
      `embeddings: switched ${prev.provider} ${prev.model} (dim=${prev.dim}) → ${next.provider} ${next.model} (dim=${next.dim}) — ${reason}`,
    );
    this.armReprobe();
    for (const fn of this.listeners) {
      try { fn(next); } catch (err) { log.debug(`embeddings: swap listener failed — ${String(err)}`); }
    }
    if (next.model !== prev.model) this.scheduleReembed(2_000);
    return true;
  }

  status(): EmbeddingsStatus {
    const c = this.inner;
    const local = c instanceof LocalEmbeddings ? c.status() : null;
    return {
      provider: c.provider,
      model: c.model,
      dim: c.dim,
      activeProvider: c instanceof ChainedEmbeddings ? c.getActiveProvider() : c.provider,
      lastResort: this.opts.isLastResort?.(c) ?? false,
      local,
      reembed: this.reembed?.status() ?? null,
    };
  }

  stop(): void {
    if (this.reprobeTimer) clearInterval(this.reprobeTimer);
    if (this.reembedTimer) clearTimeout(this.reembedTimer);
    this.reprobeTimer = null;
    this.reembedTimer = null;
    this.reembed?.stop();
  }
}

let activeManager: EmbeddingsManager | null = null;

/** The manager bootstrap built, for status routes. Null before boot wires it. */
export function getActiveEmbeddingsManager(): EmbeddingsManager | null {
  return activeManager;
}

export function setActiveEmbeddingsManager(m: EmbeddingsManager | null): void {
  activeManager = m;
}

/** Dimension of the chat-memory and experience-graph vector indexes. */
export const CHAT_MEMORY_DIM = 384;

/**
 * The client chat memory embeds with: the active one when its vectors fit the
 * chat graph's 384d index, else the in-process default model (a 1536d OpenAI
 * primary must not write into that index). Before boot wires the manager it is
 * the in-process model too. Every vector chat writes is tagged with
 * `embedding_model`, so a later switch is caught by the re-embed pass.
 */
export function embeddingsForChat(): EmbeddingsClient {
  const m = activeManager;
  if (m && m.dim === CHAT_MEMORY_DIM) return m;
  return sharedLocalEmbeddings();
}

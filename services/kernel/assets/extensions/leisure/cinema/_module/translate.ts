/**
 * Subtitle translation engines:
 *   - nllb — Meta's NLLB-200 distilled, runs offline on CPU via ONNX.
 *            Slow (~10 min for a feature film) but no GPU/API needed and no
 *            outbound network call.
 *   - llm  — Routes through the central LlmClient (src/core/llm/client.ts),
 *            so the primary + fallback chain configured at /models decides
 *            which provider runs (Grok, Claude, LM Studio, NVIDIA NIM, …).
 *            Quota/auth/rate-limit failures fall through to the next link
 *            in the chain automatically — no per-engine cooldown needed
 *            here, the LlmClient + provider-health tracker handle it.
 *
 * Both engines expose the same `translateBatch(engine, texts, opts)` shape.
 * The return value now carries the actual provider/model that produced the
 * translation so the route can record it in the sidecar + response headers
 * (so the UI can show "translated by grok / grok-4-fast-non-reasoning"
 * even when the user picked "llm" and the chain ended up picking Grok).
 */

import { log } from "../../../../../src/core/logger.js";
import { llm } from "../../../../../src/core/llm/client.js";
import { nllbCode } from "./subtitles.js";

export type TranslateEngine = "nllb" | "llm";

export interface TranslateProgress {
  batchIdx: number;
  totalBatches: number;
  cuesDone: number;
  cuesTotal: number;
  lastBatchMs: number;
  elapsedMs: number;
  etaMs: number;
}

export interface TranslateOpts {
  src: string;       // ISO-639-1 (e.g. "en") or NLLB Flores ("eng_Latn")
  tgt: string;
  /** Aborts between batches. In-flight batches finish; nothing new starts. */
  signal?: AbortSignal;
  /** Batches in flight at once. Defaults per engine — see LLM_CONCURRENCY. */
  concurrency?: number;
  /** Per-batch progress hook. Fires after every batch (not just log
   *  heartbeats), so SSE subscribers see a steady stream. */
  onProgress?: (p: TranslateProgress) => void;
}

export interface TranslateResult {
  translations: string[];
  engineUsed: TranslateEngine;
  /** Logical provider slug from the chain when engineUsed === "llm"
   *  (e.g. "grok", "claude", "lmstudio"). Set on the *last* successful
   *  batch — the chain may re-rank between batches, but UI-side that's
   *  acceptable noise for a "translated by …" label. */
  providerUsed?: string;
  /** Model string returned by the provider (or the offline NLLB model id). */
  modelUsed?: string;
  /** Batches that never got an answer and kept their source text. */
  fallbackBatches?: number;
  totalBatches?: number;
}

// ── NLLB-200 (offline) ──────────────────────────────────────────────────

const NLLB_MODEL = "Xenova/nllb-200-distilled-600M";
let nllbPipeline: any | null = null;
let nllbLoading: Promise<any> | null = null;

async function getNllb(): Promise<any> {
  if (nllbPipeline) return nllbPipeline;
  if (nllbLoading) return nllbLoading;
  log.info(`Loading NLLB-200 (${NLLB_MODEL})… first call downloads ~600MB`);
  nllbLoading = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    nllbPipeline = await pipeline("translation", NLLB_MODEL, { dtype: "fp32" });
    return nllbPipeline;
  })();
  return nllbLoading;
}

async function translateBatchNllb(
  texts: string[],
  opts: TranslateOpts,
): Promise<string[]> {
  const pipe = await getNllb();
  const src = nllbCode(opts.src);
  const tgt = nllbCode(opts.tgt);
  const out = await pipe(texts, {
    src_lang: src,
    tgt_lang: tgt,
    max_length: 256,
  });
  if (Array.isArray(out)) {
    return out.map((r: any) => (r?.translation_text ?? "").trim());
  }
  return [(out as any)?.translation_text ?? ""];
}

// ── LLM chain (grok / claude / lmstudio / etc — whoever /models picks) ──

const SYSTEM_PROMPT =
  "You are a precise subtitle translator. Output only the numbered translations, one per line. " +
  "Do not include reasoning, analysis, headers, or any text outside the numbered list. " +
  // Qwen3 / many "thinking" models honour /no_think — the reasoning block
  // would be huge waste here (translation is direct) and would force us to
  // wait for it before getting any text.
  "/no_think";

function buildPrompt(texts: string[], opts: TranslateOpts): string {
  const lines = texts.map((t, i) => `${i + 1}. ${t.replace(/\n/g, " ⏎ ")}`).join("\n");
  return `Translate the following ${texts.length} subtitle cues from ${opts.src} to ${opts.tgt}.
RULES:
- Keep each cue on its own numbered line, in the exact same order.
- Preserve the " ⏎ " marker (it represents a line break inside one cue).
- Do NOT invent text. If a cue is "[music]" or similar, translate accordingly ("[música]").
- Do NOT add commentary, headers, or surrounding quotes.
- Output ONLY the numbered translated lines.

CUES:
${lines}`;
}

async function translateBatchLlm(
  texts: string[],
  opts: TranslateOpts,
): Promise<{ translations: string[]; provider: string; model: string }> {
  const result = await llm().chat({
    system: SYSTEM_PROMPT,
    user: buildPrompt(texts, opts),
    temperature: 0.1,
    // Cap predicted tokens so a runaway model can't blow context on a small
    // chunk. 60 tokens/cue floor covers cues up to ~40 chars; the floor of
    // 400 covers very small batches at the end of a file.
    maxTokens: Math.max(400, texts.length * 60),
    caller: "subs:translate",
  });
  return {
    translations: parseNumberedLines(result.text, texts.length),
    provider: result.provider,
    model: result.model,
  };
}

function parseNumberedLines(raw: string, expected: number): string[] {
  // Strip Qwen3 / DeepSeek-style chain-of-thought blocks. Many "thinking"
  // models wrap their reasoning in <think>...</think> before the actual
  // answer; without this we'd parse the reasoning as if it were cues and
  // the translation would come out broken. Also strip the rare
  // `<reasoning>` and `<analysis>` tags some forks use.
  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "");
  // Some models open <think> but never close it (truncated context).
  // Drop everything before the first numbered line in that case.
  if (/<think>/i.test(cleaned)) {
    const firstNumberedLine = cleaned.search(/^\s*\d+[.)\]:]/m);
    if (firstNumberedLine >= 0) cleaned = cleaned.slice(firstNumberedLine);
  }
  const out: string[] = new Array(expected).fill("");
  const lines = cleaned.split(/\n+/).map(l => l.trim()).filter(Boolean);
  let cursor = 0;
  for (const line of lines) {
    const m = /^(\d+)[.)\]:]\s*(.*)$/.exec(line);
    if (m) {
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < expected) {
        out[idx] = m[2].replace(/ ⏎ /g, "\n");
        cursor = idx + 1;
        continue;
      }
    }
    if (cursor > 0 && cursor <= expected) {
      out[cursor - 1] = (out[cursor - 1] + " " + line).trim();
    }
  }
  return out.map(s => s.replace(/ ⏎ /g, "\n"));
}

// ── Public dispatcher ──────────────────────────────────────────────────

const NLLB_BATCH = 16;   // CPU memory-bound; raise on GPU.
const LLM_BATCH  = 22;   // Cloud-or-local OpenAI-compatible: tight enough
                          // that a small 7B model can hold the whole list
                          // in context, large enough that per-call latency
                          // amortises across many cues.

/**
 * How many batches are in flight at once.
 *
 * LLM batches are network-bound — one call spends 15-30s waiting on a remote
 * model — so running them one at a time wasted the entire wall-clock on
 * latency: a 683-cue feature film took 12.5 minutes at 32 sequential batches.
 * The chain below already sequentialises per link's rate limit and carries a
 * 429 concurrency limiter, so issuing several at once is safe and is exactly
 * what TranslateRunner does for descriptions.
 *
 * NLLB stays at 1: it runs locally on CPU and is memory-bound, so parallel
 * batches contend for the same cores and thrash rather than overlap.
 */
const LLM_CONCURRENCY = 4;
const NLLB_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;
/** Attempts per batch before falling back to the source text. */
const BATCH_ATTEMPTS = 2;
const BATCH_RETRY_MS = 800;

/**
 * Did the provider decline on content grounds rather than fail?
 *
 * The distinction matters twice over. A refusal is deterministic — the same
 * cues sent to the same model produce the same refusal, so retrying burns a
 * call and doubles the time to failure for nothing. And it is not fixed by
 * waiting or by a healthier link: it needs a different model, which is a
 * different sentence to put in front of the user than "the batch failed".
 *
 * Old films are exactly where this bites. A 1980 disaster picture's dialogue
 * carries plague, corpses and war, and a safety-tuned model will decline to
 * translate a block of it while happily doing the rest of the reel.
 */
export function isContentRefusal(msg: string): boolean {
  return /usage policy|content[ _-]?policy|unable to respond to this request|\baup\b|\brefus(e|ed|al)\b|declined to (answer|respond)/i
    .test(msg);
}

/** One batch, one call. Injected so the pool can be tested without a provider. */
export type BatchRunner = (
  chunk: string[],
  opts: TranslateOpts,
) => Promise<{ translations: string[]; provider?: string; model?: string }>;

export async function translateBatch(
  engine: TranslateEngine,
  texts: string[],
  opts: TranslateOpts,
): Promise<TranslateResult> {
  const runner: BatchRunner = engine === "llm"
    ? async (chunk, o) => {
        const r = await translateBatchLlm(chunk, o);
        return { translations: r.translations, provider: r.provider, model: r.model };
      }
    : async (chunk, o) => ({
        translations: await translateBatchNllb(chunk, o),
        model: NLLB_MODEL,
      });
  return runBatchPool(engine, texts, opts, runner);
}

/**
 * The concurrency pool. Split out from `translateBatch` so the ordering,
 * the retry/abort rules and the progress arithmetic can be tested against a
 * fake runner instead of a live model.
 */
export async function runBatchPool(
  engine: TranslateEngine,
  texts: string[],
  opts: TranslateOpts,
  runBatch: BatchRunner,
): Promise<TranslateResult> {
  const batchSize = engine === "llm" ? LLM_BATCH : NLLB_BATCH;
  const totalBatches = Math.ceil(texts.length / batchSize);
  const concurrency = Math.max(
    1,
    Math.min(
      MAX_CONCURRENCY,
      opts.concurrency ?? (engine === "llm" ? LLM_CONCURRENCY : NLLB_CONCURRENCY),
      totalBatches,
    ),
  );
  // Pre-sized so out-of-order completions land at their own offset. Pushing
  // was only correct while batches finished in order.
  const out: string[] = new Array(texts.length).fill("");
  const logEvery = Math.max(1, Math.floor(totalBatches / 12));
  const startedAt = Date.now();
  let lastProvider: string | undefined;
  let lastModel: string | undefined;
  // Failures since the last success. Same intent as the old "3 consecutive
  // failures = the chain is exhausted", expressed in a way that survives
  // out-of-order completion: any success anywhere resets it.
  let failuresSinceSuccess = 0;
  let batchesDone = 0;
  let cuesDone = 0;
  /** Batches that exhausted their retries and kept the source text. */
  let fallbackBatches = 0;
  let aborted: Error | null = null;
  /** Set when the provider declined on content grounds — see isContentRefusal. */
  let refused = false;
  let cursor = 0;

  const abortRequested = () =>
    aborted ?? (opts.signal?.aborted
      ? new Error(`translate ${engine}: cancelled`)
      : null);

  async function worker(): Promise<void> {
    for (;;) {
      if (abortRequested()) return;
      const i = cursor;
      if (i >= texts.length) return;
      cursor += batchSize;

      const chunk = texts.slice(i, i + batchSize);
      const batchNo = Math.floor(i / batchSize) + 1;
      const batchStartMs = Date.now();
      let translated: string[] | null = null;
      let lastErr = "";

      // Retry before giving up on a batch. Running N calls at once makes
      // transient rejections (rate limit, a provider dropping one request in a
      // burst) meaningfully more likely than they were one-at-a-time, and the
      // fallback below is to keep the SOURCE text — which the route then reads
      // as "the model silently passed through" and rejects the whole file with
      // a 502. One in-place retry is far cheaper than losing 30 good batches.
      for (let attempt = 1; attempt <= BATCH_ATTEMPTS && translated === null; attempt++) {
        if (abortRequested()) return;
        try {
          const r = await runBatch(chunk, opts);
          translated = r.translations;
          if (r.provider) lastProvider = r.provider;
          if (r.model) lastModel = r.model;
        } catch (err) {
          lastErr = (err as Error).message;
          if (isContentRefusal(lastErr)) {
            // Deterministic. Retrying re-sends the same cues to the same model
            // for the same answer, and no other batch will fare better — the
            // model is not going to change its mind about this film. Stop the
            // whole run now with something the user can act on, instead of
            // three rounds of retries ending in "3 consecutive batch failures",
            // which reads like the provider was down.
            refused = true;
            aborted = new Error(
              `translate ${engine}: the model declined to translate this subtitle text ` +
              `(content policy). Pick a different model for subtitles at Settings → AI, ` +
              `or use engine=nllb, which runs offline and does not moderate. ` +
              `Provider said: ${lastErr}`,
            );
            return;
          }
          if (attempt < BATCH_ATTEMPTS) {
            log.warn(
              `translate ${engine}: batch #${batchNo} attempt ${attempt}/${BATCH_ATTEMPTS} failed, retrying: ${lastErr}`,
            );
            await new Promise((r) => setTimeout(r, BATCH_RETRY_MS * attempt));
          }
        }
      }

      if (translated === null) {
        failuresSinceSuccess++;
        fallbackBatches++;
        log.warn(`translate ${engine}: batch #${batchNo} (cues ${i}-${i + chunk.length}) gave up: ${lastErr}`);
        // Whole chain dead (every key dead / every quota burnt) — stop rather
        // than produce N more identical errors and a fully untranslated VTT.
        // The caller's catch surfaces the real cause to SSE and the UI.
        if (failuresSinceSuccess >= 3) {
          aborted = new Error(
            `translate ${engine}: aborted after ${failuresSinceSuccess} consecutive batch failures — ${lastErr}`,
          );
          return;
        }
        translated = chunk;   // fall back to the source text for this batch
      } else {
        failuresSinceSuccess = 0;
      }

      // Normalize length before writing so a short/long model reply cannot
      // shift every later cue out of sync.
      if (translated.length < chunk.length) {
        while (translated.length < chunk.length) translated.push(chunk[translated.length]);
      } else if (translated.length > chunk.length) {
        translated = translated.slice(0, chunk.length);
      }
      for (let j = 0; j < chunk.length; j++) out[i + j] = translated[j];

      const batchMs = Date.now() - batchStartMs;
      const elapsedMs = Date.now() - startedAt;
      batchesDone++;
      cuesDone += chunk.length;
      // Throughput-based, so it stays honest under concurrency: batchesDone
      // accrues N times faster, which is exactly the speed-up to project.
      const remainingBatches = totalBatches - batchesDone;
      const etaMs = batchesDone > 0
        ? Math.round((elapsedMs / batchesDone) * remainingBatches)
        : 0;
      if (opts.onProgress) {
        try {
          opts.onProgress({
            batchIdx: batchesDone,
            totalBatches,
            cuesDone,
            cuesTotal: texts.length,
            lastBatchMs: batchMs,
            elapsedMs,
            etaMs,
          });
        } catch { /* hook errors must not break translation */ }
      }
      if (batchesDone === totalBatches || batchesDone % logEvery === 0) {
        const tag = engine === "llm" && lastProvider ? `${engine}:${lastProvider}` : engine;
        log.info(
          `translate ${tag}: batch ${batchesDone}/${totalBatches} (${cuesDone}/${texts.length} cues, ` +
          `x${concurrency}) — last ${batchMs}ms · elapsed ${(elapsedMs / 1000).toFixed(1)}s · ` +
          `eta ${(etaMs / 1000).toFixed(1)}s · #${batchNo}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const abortErr = abortRequested();
  if (abortErr) throw abortErr;

  if (refused) {
    log.warn(`translate ${engine}: run stopped — provider declined on content grounds`);
  }
  if (fallbackBatches > 0) {
    // Says out loud what the caller would otherwise only infer from a high
    // identical-cue ratio — and misattribute to "the model passed the text
    // through" rather than "N batches never got an answer".
    log.warn(
      `translate ${engine}: ${fallbackBatches}/${totalBatches} batch(es) kept their source text after ` +
      `${BATCH_ATTEMPTS} attempts each — the output is partially untranslated`,
    );
  }

  return {
    translations: out,
    engineUsed: engine,
    providerUsed: lastProvider,
    modelUsed: lastModel,
    fallbackBatches,
    totalBatches,
  };
}

/** Is at least one chain link usable? Used by the route gate to fail fast
 *  with a clean "configure a provider at /models" message instead of
 *  letting the first batch crash with "openai 401". */
export function isLlmChainAvailable(): boolean {
  const chain = llm().describeChain();
  return chain.primary.available || chain.fallbacks.some(f => f.available);
}

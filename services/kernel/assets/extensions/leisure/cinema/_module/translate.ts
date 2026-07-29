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
  signal?: AbortSignal;
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

export async function translateBatch(
  engine: TranslateEngine,
  texts: string[],
  opts: TranslateOpts,
): Promise<TranslateResult> {
  const batchSize = engine === "llm" ? LLM_BATCH : NLLB_BATCH;
  const out: string[] = [];
  const totalBatches = Math.ceil(texts.length / batchSize);
  const logEvery = Math.max(1, Math.floor(totalBatches / 12));
  const startedAt = Date.now();
  let lastProvider: string | undefined;
  let lastModel: string | undefined;
  // Track consecutive batch failures. If every batch in the chain blew up,
  // the chain is exhausted (every key dead / every quota burnt) — bail
  // instead of returning a fully untranslated SRT.
  let consecutiveFailures = 0;
  for (let i = 0; i < texts.length; i += batchSize) {
    const chunk = texts.slice(i, i + batchSize);
    const batchIdx = Math.floor(i / batchSize) + 1;
    const batchStartMs = Date.now();
    let translated: string[];
    try {
      if (engine === "llm") {
        const r = await translateBatchLlm(chunk, opts);
        translated = r.translations;
        lastProvider = r.provider;
        lastModel = r.model;
      } else {
        translated = await translateBatchNllb(chunk, opts);
        lastModel = NLLB_MODEL;
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      const msg = (err as Error).message;
      log.warn(`translate ${engine}: batch ${i}-${i + chunk.length} failed: ${msg}`);
      // 3 consecutive failures = whole chain is dead (or NLLB is broken).
      // Abort instead of producing N more identical errors and a fully
      // untranslated VTT — the caller's catch will surface the real cause
      // to the SSE channel + the UI.
      if (consecutiveFailures >= 3) {
        throw new Error(
          `translate ${engine}: aborted after ${consecutiveFailures} consecutive batch failures — ${msg}`,
        );
      }
      translated = chunk;
    }
    if (translated.length < chunk.length) {
      while (translated.length < chunk.length) translated.push(chunk[translated.length]);
    } else if (translated.length > chunk.length) {
      translated = translated.slice(0, chunk.length);
    }
    out.push(...translated);
    const batchMs = Date.now() - batchStartMs;
    const elapsedMs = Date.now() - startedAt;
    const remainingBatches = totalBatches - batchIdx;
    const avgPerBatch = elapsedMs / batchIdx;
    const etaMs = Math.round(avgPerBatch * remainingBatches);
    const cuesDone = i + chunk.length;
    if (opts.onProgress) {
      try {
        opts.onProgress({
          batchIdx,
          totalBatches,
          cuesDone,
          cuesTotal: texts.length,
          lastBatchMs: batchMs,
          elapsedMs,
          etaMs,
        });
      } catch { /* hook errors must not break translation */ }
    }
    if (batchIdx === totalBatches || batchIdx % logEvery === 0) {
      const tag = engine === "llm" && lastProvider ? `${engine}:${lastProvider}` : engine;
      log.info(
        `translate ${tag}: batch ${batchIdx}/${totalBatches} (${cuesDone}/${texts.length} cues) — ` +
        `last ${batchMs}ms · elapsed ${(elapsedMs / 1000).toFixed(1)}s · eta ${(etaMs / 1000).toFixed(1)}s`,
      );
    }
  }
  return { translations: out, engineUsed: engine, providerUsed: lastProvider, modelUsed: lastModel };
}

/** Is at least one chain link usable? Used by the route gate to fail fast
 *  with a clean "configure a provider at /models" message instead of
 *  letting the first batch crash with "openai 401". */
export function isLlmChainAvailable(): boolean {
  const chain = llm().describeChain();
  return chain.primary.available || chain.fallbacks.some(f => f.available);
}

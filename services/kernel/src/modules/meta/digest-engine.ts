/**
 * Pure map-reduce orchestration for kernel_research_digest. No I/O of its
 * own: the caller injects `complete` (one LLM round) so this is fully
 * deterministic under test. Bakes in the rate-limit lessons:
 * concurrency cap + cooldown between launches.
 */

export interface DigestItem {
  id: string;
  text: string;
}

export interface MapReduceDeps {
  /** One LLM completion. Returns the text and tokens spent. */
  complete: (system: string, user: string) => Promise<{ text: string; tokens: number }>;
  /** Injectable sleep (defaults to setTimeout) — overridable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface MapReduceInput {
  items: DigestItem[];
  mapInstruction: string;
  reduceInstruction: string;
  chunkSize: number;
  concurrency: number;
  cooldownMs: number;
}

export interface MapReduceResult {
  digest: string;
  citations: string[];
  chunksProcessed: number;
  chunksFailed: number;
  tokens: number;
}

const MAP_SYSTEM =
  "You summarize ONLY the provided items. Never invent ids, urls, or facts not present below. " +
  "Reference items by their #id.";
const REDUCE_SYSTEM = "You combine the partial summaries below into one coherent result.";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function renderChunk(items: DigestItem[]): string {
  return items.map((it) => `#${it.id}: ${it.text}`).join("\n");
}

export async function mapReduce(
  input: MapReduceInput,
  deps: MapReduceDeps,
): Promise<MapReduceResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const batches = chunk(input.items, Math.max(1, input.chunkSize));
  if (batches.length === 0) {
    return { digest: "", citations: [], chunksProcessed: 0, chunksFailed: 0, tokens: 0 };
  }

  type MapOutcome = { ok: boolean; text: string; ids: string[]; tokens: number };
  const results: MapOutcome[] = new Array(batches.length);
  let totalTokens = 0;

  // Concurrency-limited launcher with cooldown between starts.
  let next = 0;
  let firstLaunch = true;
  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= batches.length) return;
      if (!firstLaunch && input.cooldownMs > 0) await sleep(input.cooldownMs);
      firstLaunch = false;
      const batch = batches[idx];
      const ids = batch.map((b) => b.id);
      const user = `${input.mapInstruction}\n\nITEMS:\n${renderChunk(batch)}`;
      try {
        const r = await deps.complete(MAP_SYSTEM, user);
        results[idx] = { ok: true, text: r.text, ids, tokens: r.tokens };
      } catch {
        results[idx] = { ok: false, text: "", ids, tokens: 0 };
      }
    }
  }
  const pool = Array.from({ length: Math.max(1, input.concurrency) }, () => worker());
  await Promise.all(pool);

  const ok = results.filter((r) => r.ok);
  const chunksFailed = results.length - ok.length;
  const citations = ok.flatMap((r) => r.ids);
  totalTokens += results.reduce((s, r) => s + r.tokens, 0);

  // ── reduce ───────────────────────────────────────────────────────
  // One reduce round whenever more than one chunk succeeded — that is what
  // synthesizes many per-chunk summaries into a single grounded digest.
  let digest: string;
  if (ok.length === 0) {
    digest = "";
  } else if (ok.length === 1) {
    digest = ok[0].text;
  } else {
    const joined = ok.map((r, i) => `[chunk ${i + 1}]\n${r.text}`).join("\n\n");
    const user = `${input.reduceInstruction}\n\nPARTIAL SUMMARIES:\n${joined}`;
    try {
      const r = await deps.complete(REDUCE_SYSTEM, user);
      digest = r.text;
      totalTokens += r.tokens;
    } catch {
      // Reduce failed but map outputs exist → return them rather than erroring.
      digest = joined;
    }
  }

  return {
    digest,
    citations,
    chunksProcessed: ok.length,
    chunksFailed,
    tokens: totalTokens,
  };
}

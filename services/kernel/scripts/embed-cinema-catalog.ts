/**
 * Tight-loop embedder driver. Hits POST /api/cinema/embed/run repeatedly
 * with batch_size=128 until pending hits zero. Bypasses the 5-minute
 * cron tick — fills the catalog in 30-60 minutes instead of 25 hours.
 *
 * The kernel-side embedPending() is what actually does the work; this
 * script just keeps the pipeline busy. LMStudio bge-m3 is the real
 * bottleneck (~130 texts/sec). Smaller batch_size reduces tail
 * latency at the cost of overhead; 128 is a decent sweet spot.
 *
 * Env:
 *   KERNEL_URL    default http://localhost:3086
 *   BATCH_SIZE    default 128 (max 256)
 *   PAUSE_MS      default 0   (no inter-batch delay; LMStudio pacing is enough)
 */

const KERNEL_URL = (process.env.KERNEL_URL ?? "http://localhost:3086").replace(/\/+$/, "");
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? "128", 10);
const PAUSE_MS = parseInt(process.env.PAUSE_MS ?? "0", 10);

interface EmbedResult {
  embedded: number;
  graph_writes: number;
  duration_ms: number;
  pending: number;
  model: string;
  dim: number;
}

async function embedOnce(): Promise<EmbedResult | null> {
  const r = await fetch(`${KERNEL_URL}/api/cinema/embed/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ batch_size: BATCH_SIZE }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.error(`✗ embed failed (${r.status}): ${txt.slice(0, 200)}`);
    return null;
  }
  return (await r.json()) as EmbedResult;
}

async function main(): Promise<void> {
  console.log(`Tight-loop embedder · kernel=${KERNEL_URL} · batch=${BATCH_SIZE}`);

  const startedAt = Date.now();
  let totalEmbedded = 0;
  let tick = 0;

  while (true) {
    tick++;
    const r = await embedOnce();
    if (!r) {
      console.log(`tick ${tick}: aborting`);
      break;
    }
    totalEmbedded += r.embedded;
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = totalEmbedded / Math.max(1, elapsed);
    const eta = r.pending / Math.max(1, rate);
    console.log(
      `[${String(tick).padStart(4)}] ` +
        `embedded=${String(r.embedded).padStart(4)} ` +
        `graph=${String(r.graph_writes).padStart(4)} ` +
        `${String(r.duration_ms).padStart(5)}ms · ` +
        `total=${totalEmbedded} pending=${r.pending} ` +
        `· rate=${rate.toFixed(1)}/s · eta=${(eta / 60).toFixed(1)}m`,
    );
    if (r.embedded === 0) {
      console.log("✓ no more pending titles — done");
      break;
    }
    if (PAUSE_MS > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\n✓ embedded ${totalEmbedded} titles in ${elapsed}s`);
}

main().catch((err) => {
  console.error("\n✗ failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

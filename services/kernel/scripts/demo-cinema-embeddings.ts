/**
 * Stage-0 probe — LMStudio embeddings via OpenAI-compatible endpoint.
 *
 * Verifies three things before we commit to bge-m3 as the cinema embedder:
 *   1. /v1/embeddings reaches and returns a 200 with the expected dim.
 *   2. Spanish semantic similarity is sane: paraphrase close, unrelated far,
 *      cross-lingual (ES↔EN) reasonably close.
 *   3. Throughput is acceptable to embed ~50k movie descriptions in batches.
 *
 * Run:
 *   npx tsx scripts/demo-cinema-embeddings.ts
 *
 * Env overrides:
 *   LMSTUDIO_BASE_URL   default http://127.0.0.1:1234/v1
 *   EMBEDDINGS_MODEL    default text-embedding-bge-m3
 */

const BASE_URL = (process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1").replace(/\/+$/, "");
const MODEL = process.env.EMBEDDINGS_MODEL ?? "text-embedding-bge-m3";

interface EmbeddingsResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

async function embed(input: string | string[]): Promise<{ vectors: number[][]; ms: number; tokens?: number }> {
  const t0 = Date.now();
  const r = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${r.statusText} — ${text.slice(0, 300)}`);
  }
  const body = (await r.json()) as EmbeddingsResponse;
  const vectors = body.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);
  return { vectors, ms: Date.now() - t0, tokens: body.usage?.total_tokens };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

function bar(s: string): void {
  console.log("\n" + "─".repeat(72) + "\n  " + s + "\n" + "─".repeat(72));
}

async function main(): Promise<void> {
  bar(`Probe · ${BASE_URL}/embeddings · model=${MODEL}`);

  // ── 1) Single embedding — verifies endpoint, dimension, baseline latency.
  const r1 = await embed("hola mundo");
  const dim = r1.vectors[0]?.length ?? 0;
  console.log(`single 'hola mundo' → dim=${dim} · ${r1.ms} ms · tokens=${r1.tokens ?? "?"}`);
  if (dim !== 1024) {
    console.log(`⚠ expected 1024 for bge-m3, got ${dim}. Set EMBEDDINGS_DIM=${dim} when wiring.`);
  } else {
    console.log("✓ dim matches bge-m3 spec");
  }

  // ── 2) Spanish semantic sanity check.
  bar("Spanish similarity matrix");
  const probes = [
    "película de terror clásica con vampiros y castillos góticos",       // A
    "film de horror antiguo con drácula y casas embrujadas",             // A' paraphrase ES
    "old vampire horror movie with gothic castles",                      // A_en cross-lingual
    "documental sobre cocina italiana tradicional y pastas caseras",     // B unrelated
    "el gato durmió encima del teclado todo el día",                     // C unrelated
  ];
  const r2 = await embed(probes);
  console.log(`batch ${probes.length} → ${r2.ms} ms total (${(r2.ms / probes.length).toFixed(0)} ms/text avg)\n`);

  const labels = ["A", "A'", "A_en", "B", "C"];
  process.stdout.write("       ");
  for (const l of labels) process.stdout.write(l.padStart(8));
  process.stdout.write("\n");
  for (let i = 0; i < r2.vectors.length; i++) {
    process.stdout.write("  " + labels[i].padEnd(5));
    for (let j = 0; j < r2.vectors.length; j++) {
      process.stdout.write(cosine(r2.vectors[i], r2.vectors[j]).toFixed(3).padStart(8));
    }
    process.stdout.write("\n");
  }

  const aaPrime = cosine(r2.vectors[0], r2.vectors[1]);
  const aaEn = cosine(r2.vectors[0], r2.vectors[2]);
  const ab = cosine(r2.vectors[0], r2.vectors[3]);
  const ac = cosine(r2.vectors[0], r2.vectors[4]);

  console.log("\nexpectations (bge-m3 typical thresholds):");
  console.log(`  ES paraphrase   sim(A, A')   = ${aaPrime.toFixed(3)}  ${aaPrime > 0.70 ? "✓" : "✗ too low (expected > 0.70)"}`);
  console.log(`  cross-lingual   sim(A, A_en) = ${aaEn.toFixed(3)}  ${aaEn > 0.65 ? "✓" : "✗ too low (expected > 0.65)"}`);
  console.log(`  unrelated topic sim(A, B)    = ${ab.toFixed(3)}  ${ab < 0.55 ? "✓" : "✗ too high (expected < 0.55)"}`);
  console.log(`  unrelated topic sim(A, C)    = ${ac.toFixed(3)}  ${ac < 0.55 ? "✓" : "✗ too high (expected < 0.55)"}`);

  // ── 3) Throughput — typical movie description batch.
  bar("Throughput — batch of 32 movie descriptions");
  const topics = ["amor", "guerra", "ciencia ficción", "comedia", "western", "musical", "noir", "aventura"];
  const samples: string[] = [];
  for (let i = 0; i < 32; i++) {
    samples.push(
      `Película ${i + 1}: una historia de ${topics[i % topics.length]} ambientada en ${1900 + (i * 3) % 120}, ` +
      `dirigida por un cineasta independiente, con escenas memorables en blanco y negro.`,
    );
  }
  const t0 = Date.now();
  const r3 = await embed(samples);
  const totalMs = Date.now() - t0;
  console.log(`32 texts → ${totalMs} ms total · ${(totalMs / 32).toFixed(1)} ms/text · ${((32 / totalMs) * 1000).toFixed(1)} texts/sec`);
  console.log(`vectors returned: ${r3.vectors.length}`);

  // Rough projection for catalog ingestion scale.
  const target = 50000;
  const projectedSec = (totalMs / 32) * target / 1000;
  console.log(`projected: ${target} descriptions ≈ ${projectedSec.toFixed(0)} s ≈ ${(projectedSec / 60).toFixed(1)} min`);

  console.log("\n✓ probe complete — ready for stage 1 if all 4 expectations passed.");
}

main().catch((err) => {
  console.error("\n✗ probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

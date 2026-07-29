/**
 * Backfill embeddings for rows that pre-date migration v34.
 *
 * The kernel writes embeddings for all NEW agent_memory / agent_learnings /
 * agent_runs rows via AgentService.scheduleEmbed (best-effort, fire-and-
 * forget). Existing rows have `embedding = NULL` until this script
 * rewrites them.
 *
 * The reader (rankByEmbedding) degrades to lexical for null-embedding rows,
 * so the script can run incrementally without breaking semantic ranking
 * mid-flight — each batch makes more rows participate in cosine.
 *
 * IMPORTANT: the script uses the SAME EmbeddingsClient factory as the
 * runtime (honors EMBEDDINGS_PROVIDER / EMBEDDINGS_MODEL / EMBEDDINGS_DIM).
 * Backfilling with MiniLM-384 when the runtime uses bge-m3-1024 would store
 * vectors of the wrong dimension, and cosineSim would silently return 0.
 *
 * Usage:
 *   bun run scripts/backfill-agent-embeddings.ts                  # all 3 tables, batch 64
 *   bun run scripts/backfill-agent-embeddings.ts --dry-run        # count work, embed nothing
 *   bun run scripts/backfill-agent-embeddings.ts --table=memory   # one table only
 *   bun run scripts/backfill-agent-embeddings.ts --max=5000       # cap rows per run (resumable)
 *   bun run scripts/backfill-agent-embeddings.ts --batch=128
 *   bun run scripts/backfill-agent-embeddings.ts --rebuild        # also re-embed rows whose
 *                                                                  # embedding_model differs
 *                                                                  # from the current model
 *
 * Env (consumed by the embeddings factory):
 *   EMBEDDINGS_PROVIDER=auto|lmstudio|local
 *   EMBEDDINGS_BASE_URL=http://127.0.0.1:1234/v1
 *   EMBEDDINGS_MODEL=text-embedding-bge-m3
 *   EMBEDDINGS_DIM=1024
 *   KERNEL_DB_PATH=data/kernel.db
 *
 * Resumable: re-running picks up where it stopped. Safe to interrupt with Ctrl+C —
 * each batch commits independently.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { loadConfig } from "../src/core/config.js";
import { createEmbeddingsClient } from "../src/core/embeddings/index.js";
import { vectorToBlob } from "../src/modules/agents/relevance.js";

// ── arg parsing ────────────────────────────────────────────────
interface CliArgs {
  dryRun: boolean;
  rebuild: boolean;
  batch: number;
  max: number | null;
  table: "memory" | "learnings" | "runs" | "all";
  progressEvery: number;
}

function parseArgs(): CliArgs {
  const out: CliArgs = {
    dryRun: false,
    rebuild: false,
    batch: 64,
    max: null,
    table: "all",
    progressEvery: 100,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--rebuild") out.rebuild = true;
    else if (a.startsWith("--batch=")) out.batch = Math.max(1, parseInt(a.slice(8), 10));
    else if (a.startsWith("--max=")) out.max = Math.max(1, parseInt(a.slice(6), 10));
    else if (a.startsWith("--progress=")) out.progressEvery = Math.max(1, parseInt(a.slice(11), 10));
    else if (a.startsWith("--table=")) {
      const v = a.slice(8);
      if (v === "memory" || v === "learnings" || v === "runs" || v === "all") out.table = v;
      else throw new Error(`unknown --table value: ${v} (use memory|learnings|runs|all)`);
    } else if (a === "--help" || a === "-h") {
      console.log("see header comment in scripts/backfill-agent-embeddings.ts");
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

// ── per-table specs ────────────────────────────────────────────
interface TableSpec {
  name: string;
  table: "agent_memory" | "agent_learnings" | "agent_runs";
  textColumn: "content" | "goal";
  embedColumn: "embedding" | "goal_embedding";
  modelColumn: "embedding_model" | "goal_embedding_model";
  /** Skip rows whose text is shorter than this (matches scheduleEmbed gate). */
  minTextLen: number;
  /** Optional extra WHERE clause appended after the NULL/model filter. */
  extraFilter?: string;
}

const SPECS: Record<Exclude<CliArgs["table"], "all">, TableSpec> = {
  memory: {
    name: "agent_memory",
    table: "agent_memory",
    textColumn: "content",
    embedColumn: "embedding",
    modelColumn: "embedding_model",
    minTextLen: 1,
  },
  learnings: {
    name: "agent_learnings",
    table: "agent_learnings",
    textColumn: "content",
    embedColumn: "embedding",
    modelColumn: "embedding_model",
    minTextLen: 1,
    extraFilter: "active = 1", // skip already-deactivated learnings — wasted compute
  },
  runs: {
    name: "agent_runs",
    table: "agent_runs",
    textColumn: "goal",
    embedColumn: "goal_embedding",
    modelColumn: "goal_embedding_model",
    minTextLen: 5, // matches createRun's gate
  },
};

// ── core backfill loop ─────────────────────────────────────────
async function backfillTable(
  db: Database,
  spec: TableSpec,
  embed: (texts: string[]) => Promise<number[][]>,
  modelTag: string,
  args: CliArgs,
  budgetRemaining: number,
): Promise<{ processed: number; embedded: number; skipped: number; failed: number }> {
  const filter =
    args.rebuild
      ? `(${spec.embedColumn} IS NULL OR ${spec.modelColumn} != ?)`
      : `${spec.embedColumn} IS NULL`;
  const filterParams = args.rebuild ? [modelTag] : [];
  const extra = spec.extraFilter ? ` AND ${spec.extraFilter}` : "";

  // Pending count (capped at 1B for sanity).
  const pendingRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ${spec.table}
       WHERE ${filter} AND length(${spec.textColumn}) >= ${spec.minTextLen}${extra}`,
    )
    .get(...filterParams) as { c: number };
  const totalPending = pendingRow.c;

  console.log(`\n── ${spec.name} ──`);
  console.log(`  pending rows: ${totalPending}`);
  if (args.dryRun) {
    console.log(`  (dry-run — embedding ${Math.min(totalPending, budgetRemaining)} skipped)`);
    return { processed: 0, embedded: 0, skipped: 0, failed: 0 };
  }
  if (totalPending === 0) {
    return { processed: 0, embedded: 0, skipped: 0, failed: 0 };
  }

  const selectStmt = db.prepare(
    `SELECT id, ${spec.textColumn} AS text FROM ${spec.table}
     WHERE ${filter} AND length(${spec.textColumn}) >= ${spec.minTextLen}${extra}
     ORDER BY rowid ASC LIMIT ?`,
  );
  const updateStmt = db.prepare(
    `UPDATE ${spec.table} SET ${spec.embedColumn} = ?, ${spec.modelColumn} = ? WHERE id = ?`,
  );

  let processed = 0;
  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  const t0 = Date.now();
  const batch = Math.min(args.batch, budgetRemaining);

  while (processed < budgetRemaining) {
    const remaining = budgetRemaining - processed;
    const fetchSize = Math.min(args.batch, remaining);
    const rows = selectStmt.all(...filterParams, fetchSize) as Array<{ id: string; text: string }>;
    if (rows.length === 0) break;

    let vecs: number[][];
    try {
      vecs = await embed(rows.map(r => r.text));
    } catch (err) {
      failed += rows.length;
      console.error(`  embed batch failed (${rows.length} rows): ${err instanceof Error ? err.message : String(err)}`);
      // Retry one-by-one to isolate poison pills; on persistent failure we skip them
      // permanently by marking with an empty-but-non-null tag so the next pass also
      // skips them. NOT done here — better-than-nothing fallback: just stop.
      break;
    }

    // Wrap in a transaction — single fsync for the whole batch is much faster.
    db.exec("BEGIN");
    try {
      for (let i = 0; i < rows.length; i++) {
        const v = vecs[i];
        if (!v || v.length === 0) {
          skipped++;
          continue;
        }
        updateStmt.run(vectorToBlob(v), modelTag, rows[i].id);
        embedded++;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      failed += rows.length;
      console.error(`  commit failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    processed += rows.length;
    if (processed % args.progressEvery < args.batch) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = processed / Math.max(elapsed, 0.001);
      const eta = Math.max(0, Math.round((totalPending - processed) / Math.max(rate, 0.001)));
      console.log(
        `  ${processed}/${totalPending} (${(processed / totalPending * 100).toFixed(1)}%) ` +
        `embedded=${embedded} skipped=${skipped} failed=${failed} ` +
        `${rate.toFixed(1)} rows/s ETA ${eta}s`,
      );
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  done in ${elapsed}s — embedded=${embedded} skipped=${skipped} failed=${failed}`);
  return { processed, embedded, skipped, failed };
}

// ── main ───────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs();
  const dbPath = process.env.KERNEL_DB_PATH ?? resolve(process.cwd(), "data/kernel.db");

  console.log(`# backfill-agent-embeddings`);
  console.log(`  db=${dbPath}`);
  console.log(`  args: dry-run=${args.dryRun} rebuild=${args.rebuild} table=${args.table} batch=${args.batch} max=${args.max ?? "∞"}`);

  // Use the same factory the runtime uses, so dims match. Loading the full
  // KernelConfig is heavier than strictly needed but guarantees parity.
  const config = loadConfig();
  const client = await createEmbeddingsClient(config);
  console.log(`  embeddings: ${client.provider} ${client.model} (dim=${client.dim})`);

  // Open DB AFTER the embeddings client is reachable — fail loud rather than
  // open a sqlite handle and not be able to do anything.
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 30000"); // backfill can clash with live writers

  const tablesToRun: Array<keyof typeof SPECS> =
    args.table === "all" ? ["memory", "learnings", "runs"] : [args.table];

  let budget = args.max ?? Number.MAX_SAFE_INTEGER;
  let totalEmbedded = 0;
  let totalFailed = 0;

  const embedFn = (texts: string[]) => client.embed(texts);

  for (const t of tablesToRun) {
    if (budget <= 0) {
      console.log(`\n(budget exhausted — stopping early; re-run to continue)`);
      break;
    }
    const spec = SPECS[t];
    const r = await backfillTable(db, spec, embedFn, client.model, args, budget);
    budget -= r.processed;
    totalEmbedded += r.embedded;
    totalFailed += r.failed;
  }

  db.close();
  console.log(`\n# done — total embedded=${totalEmbedded} failed=${totalFailed}`);
  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("backfill-agent-embeddings failed:", err);
  process.exit(1);
});

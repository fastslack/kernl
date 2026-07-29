/**
 * Demo: léxico vs semántico vs híbrido para el ranking de relevancia
 * que el AgentExecutor inyecta al system prompt en cada run.
 *
 * Compara las 3 estrategias sobre data REAL de la kernel.db:
 *   - lexical  → la actual `rankByRelevance` (overlap de keywords con stopwords ES/EN)
 *   - cosine   → cosine sim sobre Xenova/all-MiniLM-L6-v2 (384d)
 *   - hybrid   → 0.7*cosine + 0.3*lexical
 *
 * Por cada (agente, goal de un run reciente) imprime:
 *   - top 10 memorias y top 10 learnings según cada estrategia
 *   - overlap entre los rankings (cuántos items comparten)
 *   - "winners exclusivos" — items que un ranking encuentra y otro no
 *
 * Uso:
 *   bun run scripts/demo-embedding-ranking.ts
 *   bun run scripts/demo-embedding-ranking.ts --agent="Frontend Dev"
 *   bun run scripts/demo-embedding-ranking.ts --top=3 --pool=100
 *
 * Env:
 *   KERNEL_DB_PATH         ruta a la kernel.db (default: data/kernel.db)
 *
 * Pre-requisito: Bun + @huggingface/transformers (ya está en deps).
 * Cold-start: primer embed tarda 3-5s mientras descarga el modelo ONNX.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { LocalEmbeddings } from "../src/core/embeddings/local.js";
import { rankByRelevance, extractKeywords, scoreRelevance } from "../src/modules/agents/relevance.js";

// ── arg parsing ─────────────────────────────────────────────────
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args.set(m[1], m[2]);
}
const FILTER = args.get("agent") ?? "";
const TOP_AGENTS = Math.max(1, Number(args.get("top") ?? 3));
const POOL = Math.max(20, Number(args.get("pool") ?? 100));
const LIMIT = Math.max(5, Number(args.get("limit") ?? 10));
const HYBRID_W = Math.max(0, Math.min(1, Number(args.get("cosine-weight") ?? 0.7)));

const DB_PATH = process.env.KERNEL_DB_PATH ?? resolve(process.cwd(), "data/kernel.db");

// ── helpers ─────────────────────────────────────────────────────
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function clip(s: string, n: number): string {
  const oneLine = (s || "").replace(/\s+/g, " ").trim();
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + "…";
}

function intersectIds(a: string[], b: string[]): string[] {
  const set = new Set(a);
  return b.filter(id => set.has(id));
}

// ── ranking strategies ──────────────────────────────────────────
interface Item {
  id: string;
  text: string;
  meta?: string;
}
interface Ranked extends Item {
  cosineScore: number;
  lexicalScore: number;
  hybridScore: number;
}

async function rankAll(
  goal: string,
  goalVec: number[],
  pool: Item[],
  embeddings: LocalEmbeddings,
): Promise<{ lexical: Ranked[]; cosine: Ranked[]; hybrid: Ranked[] }> {
  const goalKw = extractKeywords(goal);
  const lexicalScores = pool.map(p => scoreRelevance(goalKw, p.text));
  const vecs = await embeddings.embed(pool.map(p => p.text));
  const cosineScores = vecs.map(v => cosine(goalVec, v));

  const enriched: Ranked[] = pool.map((p, i) => ({
    ...p,
    cosineScore: cosineScores[i],
    lexicalScore: lexicalScores[i],
    hybridScore: HYBRID_W * cosineScores[i] + (1 - HYBRID_W) * lexicalScores[i],
  }));

  return {
    lexical: [...enriched].sort((a, b) => b.lexicalScore - a.lexicalScore || a.text.localeCompare(b.text)).slice(0, LIMIT),
    cosine:  [...enriched].sort((a, b) => b.cosineScore  - a.cosineScore  || a.text.localeCompare(b.text)).slice(0, LIMIT),
    hybrid:  [...enriched].sort((a, b) => b.hybridScore  - a.hybridScore  || a.text.localeCompare(b.text)).slice(0, LIMIT),
  };
}

function printTable(title: string, items: Ranked[], scoreField: keyof Pick<Ranked, "lexicalScore" | "cosineScore" | "hybridScore">) {
  console.log(`\n  ${title}`);
  if (items.length === 0) { console.log("    (vacío)"); return; }
  for (const [i, r] of items.entries()) {
    const score = (r[scoreField] as number).toFixed(3);
    const cos = r.cosineScore.toFixed(3);
    const lex = r.lexicalScore.toFixed(3);
    console.log(`    ${(i + 1).toString().padStart(2)}. [${score}  cos=${cos} lex=${lex}] ${clip(r.text, 90)}`);
  }
}

function diffSummary(label: string, lex: Ranked[], cos: Ranked[], hyb: Ranked[]): void {
  const ids = (xs: Ranked[]) => xs.map(x => x.id);
  const overlapLC = intersectIds(ids(lex), ids(cos)).length;
  const overlapLH = intersectIds(ids(lex), ids(hyb)).length;
  const overlapCH = intersectIds(ids(cos), ids(hyb)).length;
  console.log(`\n  Overlap (top ${LIMIT}) — ${label}`);
  console.log(`    lexical ∩ cosine = ${overlapLC}/${LIMIT}`);
  console.log(`    lexical ∩ hybrid = ${overlapLH}/${LIMIT}`);
  console.log(`    cosine  ∩ hybrid = ${overlapCH}/${LIMIT}`);

  const lexSet = new Set(ids(lex));
  const cosOnly = cos.filter(c => !lexSet.has(c.id));
  if (cosOnly.length > 0) {
    console.log(`    items que SOLO cosine encontró (semantic-wins):`);
    for (const r of cosOnly.slice(0, 3)) {
      console.log(`      • [cos=${r.cosineScore.toFixed(3)} lex=${r.lexicalScore.toFixed(3)}] ${clip(r.text, 80)}`);
    }
  }
  const cosSet = new Set(ids(cos));
  const lexOnly = lex.filter(l => !cosSet.has(l.id));
  if (lexOnly.length > 0) {
    console.log(`    items que SOLO lexical encontró (keyword-wins):`);
    for (const r of lexOnly.slice(0, 3)) {
      console.log(`      • [cos=${r.cosineScore.toFixed(3)} lex=${r.lexicalScore.toFixed(3)}] ${clip(r.text, 80)}`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`# demo-embedding-ranking`);
  console.log(`  db=${DB_PATH}`);
  console.log(`  pool=${POOL} limit=${LIMIT} top-agents=${TOP_AGENTS} hybrid-cosine-weight=${HYBRID_W}`);
  if (FILTER) console.log(`  filter agent name LIKE '%${FILTER}%'`);

  const db = new Database(DB_PATH, { readonly: true });

  // Pick agents that actually have memory + a recent run with a non-empty goal.
  type AgentRow = { id: string; name: string; mem: number };
  const agentSql = `
    SELECT a.id, a.name, COUNT(m.id) AS mem
    FROM agents a
    JOIN agent_memory m ON m.agent_id = a.id
    WHERE a.active = 1 ${FILTER ? "AND a.name LIKE ?" : ""}
    GROUP BY a.id
    HAVING mem >= 5
    ORDER BY mem DESC
    LIMIT ?
  `;
  const agents = (FILTER
    ? db.prepare(agentSql).all(`%${FILTER}%`, TOP_AGENTS)
    : db.prepare(agentSql).all(TOP_AGENTS)) as AgentRow[];

  if (agents.length === 0) {
    console.log("\n(no se encontró ningún agente con memoria que matchee — ¿filtro mal puesto?)");
    db.close();
    return;
  }

  console.log(`\n  loading embeddings model (Xenova/all-MiniLM-L6-v2)…`);
  const embeddings = new LocalEmbeddings();
  // Warm-up — first embed downloads + initialises the ONNX pipeline (~3-5s)
  await embeddings.embed(["warmup"]);
  console.log(`  model ready (dim=${embeddings.dim})`);

  type RunRow = { id: string; goal: string };
  type MemRow = { id: string; role: string; content: string; created_at: string };
  type LearnRow = { id: string; type: string; content: string; confidence: number };

  for (const ag of agents) {
    console.log(`\n${"═".repeat(78)}\n# ${ag.name}  (id=${ag.id.slice(0, 8)}…  ${ag.mem} memorias)`);

    // Pick a recent run with a non-trivial goal to use as the query.
    const recentRun = db
      .prepare(
        `SELECT id, goal FROM agent_runs
         WHERE agent_id = ? AND goal != '' AND length(goal) >= 30
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(ag.id) as RunRow | undefined;
    if (!recentRun) {
      console.log("  (sin runs con goal — skip)");
      continue;
    }
    const goal = recentRun.goal.slice(0, 800);
    console.log(`  goal: "${clip(goal, 140)}"`);

    const [goalVec] = await embeddings.embed([goal]);

    // ── Memory ranking ────────────────────────────────────────
    const memRows = db
      .prepare(
        `SELECT id, role, content, created_at FROM agent_memory
         WHERE agent_id = ? AND length(content) >= 5
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(ag.id, POOL) as MemRow[];

    const memPool: Item[] = memRows.map(m => ({
      id: m.id,
      text: m.content,
      meta: `${m.role}@${m.created_at.slice(5, 16)}`,
    }));

    if (memPool.length >= 5) {
      console.log(`\n  ── MEMORY (pool=${memPool.length}) ──`);
      const t0 = Date.now();
      const ranks = await rankAll(goal, goalVec, memPool, embeddings);
      console.log(`  embed+rank: ${Date.now() - t0}ms`);
      printTable("LEXICAL  top:", ranks.lexical, "lexicalScore");
      printTable("COSINE   top:", ranks.cosine,  "cosineScore");
      printTable("HYBRID   top:", ranks.hybrid,  "hybridScore");
      diffSummary("memory", ranks.lexical, ranks.cosine, ranks.hybrid);

      // Sanity check — para validar el caller actual
      const currentLex = rankByRelevance(memPool, goal, m => m.text, LIMIT);
      const currentIds = new Set(currentLex.map(c => c.id));
      const newIds = new Set(ranks.lexical.map(c => c.id));
      const sameAsCurrent = [...currentIds].filter(i => newIds.has(i)).length;
      console.log(`\n  sanity: nueva LEXICAL coincide con rankByRelevance() actual en ${sameAsCurrent}/${LIMIT}`);
    }

    // ── Learnings ranking ────────────────────────────────────
    const learnRows = db
      .prepare(
        `SELECT id, type, content, confidence FROM agent_learnings
         WHERE agent_id = ? AND active = 1
         ORDER BY confidence DESC LIMIT ?`,
      )
      .all(ag.id, POOL) as LearnRow[];

    const learnPool: Item[] = learnRows.map(l => ({
      id: l.id,
      text: l.content,
      meta: `${l.type}@${l.confidence.toFixed(2)}`,
    }));

    if (learnPool.length >= 3) {
      console.log(`\n  ── LEARNINGS (pool=${learnPool.length}) ──`);
      const t0 = Date.now();
      const ranks = await rankAll(goal, goalVec, learnPool, embeddings);
      console.log(`  embed+rank: ${Date.now() - t0}ms`);
      printTable("LEXICAL  top:", ranks.lexical, "lexicalScore");
      printTable("COSINE   top:", ranks.cosine,  "cosineScore");
      printTable("HYBRID   top:", ranks.hybrid,  "hybridScore");
      diffSummary("learnings", ranks.lexical, ranks.cosine, ranks.hybrid);
    }

    // ── findSimilarPastRuns ───────────────────────────────────
    const pastRuns = db
      .prepare(
        `SELECT id, goal FROM agent_runs
         WHERE agent_id = ? AND goal != '' AND id != ?
           AND status IN ('completed', 'failed')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(ag.id, recentRun.id, POOL) as RunRow[];

    const runPool: Item[] = pastRuns.map(r => ({ id: r.id, text: r.goal }));

    if (runPool.length >= 5) {
      console.log(`\n  ── SIMILAR PAST RUNS (pool=${runPool.length}) ──`);
      const t0 = Date.now();
      const ranks = await rankAll(goal, goalVec, runPool, embeddings);
      console.log(`  embed+rank: ${Date.now() - t0}ms`);
      printTable("LEXICAL  top:", ranks.lexical.slice(0, 5), "lexicalScore");
      printTable("COSINE   top:", ranks.cosine.slice(0, 5),  "cosineScore");
      printTable("HYBRID   top:", ranks.hybrid.slice(0, 5),  "hybridScore");
      diffSummary("past-runs", ranks.lexical, ranks.cosine, ranks.hybrid);
    }
  }

  db.close();
  console.log(`\n${"═".repeat(78)}\n# done — listo para decidir threshold + cosine-weight`);
}

main().catch((err) => {
  console.error("demo-embedding-ranking failed:", err);
  process.exit(1);
});

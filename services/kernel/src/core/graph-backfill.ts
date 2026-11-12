/**
 * Graph backfill — bring each module's graph projection up to what its own
 * tables hold.
 *
 * Modules write graph nodes as their rows change. On an install whose graph
 * was off (the no-op driver) or after a switch to a fresh store, everything
 * that existed before never reached the graph, and the graph quietly answers
 * with a fraction of the data. Each module that projects into the graph can
 * offer a backfill (`KernelModule.getGraphBackfill`); this runs every one
 * that the active store has not seen yet — or has seen at an older version —
 * and records it in the store itself (`:KernlGraphBackfill`), so a new store
 * gets filled again without anyone asking.
 *
 * Best-effort throughout: a failing backfill is logged and retried on the
 * next pass; the others still run.
 */

import { log } from "./logger.js";
import type { GraphDriver } from "./db-drivers/graph-driver.js";
import type { GraphBackfill, KernelModule } from "./types.js";

export interface BackfillOutcome {
  name: string;
  status: "done" | "skipped" | "failed";
  nodes?: number;
  relationships?: number;
  ms?: number;
  error?: string;
}

export function collectGraphBackfills(modules: KernelModule[]): GraphBackfill[] {
  const out = new Map<string, GraphBackfill>();
  for (const mod of modules) {
    if (typeof mod.getGraphBackfill !== "function") continue;
    try {
      const b = mod.getGraphBackfill();
      if (b && typeof b.run === "function" && b.name && !out.has(b.name)) out.set(b.name, b);
    } catch (err) {
      log.warn(`graph backfill: ${mod.name} failed to describe its backfill — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [...out.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.name.localeCompare(b.name));
}

export async function runGraphBackfills(
  backfills: GraphBackfill[],
  graph: GraphDriver | null,
): Promise<BackfillOutcome[]> {
  if (!graph?.capabilities.cypher || backfills.length === 0) return [];
  const outcomes: BackfillOutcome[] = [];
  for (const b of backfills) {
    try {
      const seen = await graph.run(
        "MATCH (m:KernlGraphBackfill {name: $name}) RETURN m.version AS version",
        { name: b.name },
      );
      const version = Number(seen.records[0]?.get("version") ?? 0);
      if (version >= b.version) {
        outcomes.push({ name: b.name, status: "skipped" });
        continue;
      }
      const t0 = Date.now();
      const r = await b.run(graph);
      const ms = Date.now() - t0;
      await graph.run(
        `MERGE (m:KernlGraphBackfill {name: $name})
         SET m.version = $version, m.nodes = $nodes, m.relationships = $relationships, m.at = $at`,
        { name: b.name, version: b.version, nodes: r.nodes, relationships: r.relationships, at: new Date().toISOString() },
      );
      outcomes.push({ name: b.name, status: "done", nodes: r.nodes, relationships: r.relationships, ms });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`graph backfill "${b.name}" failed — will retry: ${error}`);
      outcomes.push({ name: b.name, status: "failed", error });
    }
  }
  const done = outcomes.filter((o) => o.status === "done");
  if (done.length > 0) {
    log.info(
      `graph backfill: ${done.map((o) => `${o.name} (${o.nodes} nodes, ${o.relationships} rels, ${o.ms}ms)`).join(", ")}`,
    );
  }
  return outcomes;
}

/**
 * Run the backfills shortly after boot (once the graph driver is up) and then
 * every so often — a pass where every store already has them costs one small
 * query per module.
 */
export function scheduleGraphBackfills(
  listModules: () => KernelModule[],
  getGraph: () => GraphDriver | null,
  opts: { firstDelayMs?: number; everyMs?: number } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = async () => {
    try {
      await runGraphBackfills(collectGraphBackfills(listModules()), getGraph());
    } catch (err) {
      log.warn(`graph backfill pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), opts.everyMs ?? 30 * 60_000);
    timer.unref?.();
  };
  timer = setTimeout(() => void tick(), opts.firstDelayMs ?? 20_000);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

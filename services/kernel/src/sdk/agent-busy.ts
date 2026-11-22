/**
 * Agents busy on work that is not one of their runs, for the dashboard's "working" count.
 *
 * The dashboard shows an agent working while it has an open run. Some work goes on after the run ends, on the agent's
 * behalf: a DevOps ticket's tests, preview and end-to-end checks run on the host for minutes after its coder answered.
 * Counted by runs alone, an office in full swing read "0 working".
 *
 * Whoever does such work says so here, as the whole set of one source, renewed while it lasts. A set not renewed
 * within its TTL drops, so a source that stopped (an extension disabled, a kernel module that threw) never leaves
 * agents working for good.
 */

/** One busy agent: `agent` is its id or its slug; `tag` and `title` say what it is on, as a run's goal badge does. */
export interface AgentBusyItem { agent: string; tag?: string; title?: string }
export interface AgentBusy extends AgentBusyItem { source: string }

// One map for the kernel and every extension bundle that carries a copy of this file, as llm-inflight.ts: the
// extension reports, the kernel's agent graph reads.
const BUSY_KEY = Symbol.for("kernl.agentBusy.v1");

type Entry = { items: AgentBusyItem[]; until: number };

function registry(): Map<string, Entry> {
  const g = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>;
  return (g[BUSY_KEY] ??= new Map<string, Entry>());
}

/** Replaces `source`'s busy agents; an empty list clears them. They drop on their own after `ttlMs` unless renewed. */
export function setAgentsBusy(source: string, items: AgentBusyItem[], ttlMs = 120_000, now = Date.now()): void {
  const list = items
    .filter((i) => !!i && typeof i.agent === "string" && i.agent.length > 0)
    .map((i) => ({ agent: i.agent, ...(i.tag ? { tag: String(i.tag) } : {}), ...(i.title ? { title: String(i.title) } : {}) }));
  if (!source || list.length === 0) { registry().delete(source); return; }
  registry().set(source, { items: list, until: now + ttlMs });
}

/** Every busy agent of every source still within its TTL. */
export function listAgentsBusy(now = Date.now()): AgentBusy[] {
  const out: AgentBusy[] = [];
  for (const [source, e] of registry()) {
    if (e.until <= now) { registry().delete(source); continue; }
    for (const i of e.items) out.push({ ...i, source });
  }
  return out;
}

/** Tests only. */
export function clearAgentsBusy(): void {
  registry().clear();
}

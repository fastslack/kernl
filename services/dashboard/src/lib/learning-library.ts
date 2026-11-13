/**
 * The experience library at a moment: what each agent knew then.
 *
 * The kernel sends every lesson (when it was learned, how often runs carried
 * it — /api/agents/learnings/library) and how its confidence moved over time.
 * This replays that to any moment T, so the library can be scrubbed week by
 * week: books appear when learned, grow or shrink with their confidence, fall
 * to the floor when retired, gather dust while nobody uses them.
 *
 * Pure — no Svelte, no Three.js — so it is pinned by tests.
 */

export interface LibraryBook {
  id: string;
  type: string;
  content: string;
  confidence: number;
  active: boolean;
  created_at: string;
  last_used: string | null;
  uses: number;
  shared_uses: number;
}

export interface LibraryShelf {
  id: string;
  name: string;
  flow_id: string;
  books: LibraryBook[];
}

export interface Timeline {
  points: Array<[string, number]>;
  retired_at: string | null;
}

export interface Library {
  agents: LibraryShelf[];
  timelines: Record<string, Timeline>;
  query_ms: number | null;
  cypher: string;
  graph: boolean;
}

export interface BookAt {
  /** Learned by T. */
  present: boolean;
  /** Confidence held at T. */
  confidence: number;
  /** Retired by T (fell below the floor or was swept). */
  retired: boolean;
  /** 0 fresh … 1 untouched for a month or more (since last use, or since learned). */
  dust: number;
}

const DAY = 86_400_000;

function ms(iso: string | null | undefined): number {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/** One book at moment `at` (epoch ms). Without a history, today's confidence stands for every moment. */
export function bookAt(book: LibraryBook, timeline: Timeline | undefined, at: number): BookAt {
  const born = ms(book.created_at);
  const present = !Number.isFinite(born) || born <= at;
  let confidence = book.confidence;
  const points = timeline?.points ?? [];
  if (points.length) {
    // The last value recorded by T; before the first record, the first one.
    confidence = points[0][1];
    for (const [when, value] of points) {
      if (ms(when) <= at) confidence = value;
      else break;
    }
  }
  const retiredAt = ms(timeline?.retired_at ?? null);
  const retired = !book.active && (Number.isFinite(retiredAt) ? retiredAt <= at : true);
  const lastUsed = ms(book.last_used);
  const since = Number.isFinite(lastUsed) && lastUsed <= at ? lastUsed : born;
  const dust = Number.isFinite(since) ? Math.max(0, Math.min(1, (at - since) / (30 * DAY))) : 0;
  return { present, confidence, retired, dust };
}

/** Week boundaries (epoch ms, Monday 00:00 UTC) from the first lesson to `now`, always ending at `now`. */
export function libraryWeeks(lib: Pick<Library, 'agents'>, now: number): number[] {
  let first = now;
  for (const a of lib.agents) for (const b of a.books) {
    const t = ms(b.created_at);
    if (Number.isFinite(t) && t < first) first = t;
  }
  const d = new Date(first);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  const weeks: number[] = [];
  for (let t = monday; t < now; t += 7 * DAY) weeks.push(t);
  weeks.push(now);
  return weeks;
}

export interface LibrarySummary {
  held: number;
  retired: number;
  avgConfidence: number;
  /** Lessons another agent's run carried at least once (by now — uses are not dated). */
  shared: number;
}

export function librarySummary(lib: Pick<Library, 'agents' | 'timelines'>, at: number): LibrarySummary {
  let held = 0, retired = 0, sum = 0, shared = 0;
  for (const a of lib.agents) for (const b of a.books) {
    const s = bookAt(b, lib.timelines[b.id], at);
    if (!s.present) continue;
    if (s.retired) { retired++; continue; }
    held++;
    sum += s.confidence;
    if (b.shared_uses > 0) shared++;
  }
  return { held, retired, avgConfidence: held ? sum / held : 0, shared };
}

// ── Lineage ────────────────────────────────────────────────────────────

export interface LineageUse { run: string; agent: string; name: string; status: string; at: string; child: string | null }
export interface LineageNode {
  id: string; depth: number; type: string; content: string; confidence: number; active: boolean;
  created_at: string; owner: { id: string; name: string }; from_runs: string[]; uses: LineageUse[];
}

/** A hop drawn in the office: the lesson travelling from who learned it to a run that carried it. */
export interface LineageHop {
  learningId: string;
  depth: number;
  from: string;
  to: string;
  toName: string;
  ok: boolean;
  /** The lesson that run went on to produce, if any. */
  child: string | null;
}

/** Every hop of a lineage, root first; a run of the lesson's own agent is not a hop. */
export function lineageHops(nodes: LineageNode[]): LineageHop[] {
  const hops: LineageHop[] = [];
  for (const n of [...nodes].sort((a, b) => a.depth - b.depth)) {
    for (const u of n.uses) {
      if (!u.agent || u.agent === n.owner.id) continue;
      hops.push({ learningId: n.id, depth: n.depth, from: n.owner.id, to: u.agent, toName: u.name, ok: u.status === 'completed', child: u.child });
    }
  }
  return hops;
}

/** Agents a lineage reached, and how their runs that carried it went. */
export function lineageReach(nodes: LineageNode[]): { agents: number; runs: number; ok: number; descendants: number } {
  const agents = new Set<string>();
  let runs = 0, ok = 0;
  for (const n of nodes) for (const u of n.uses) {
    runs++;
    if (u.status === 'completed') ok++;
    if (u.agent) agents.add(u.agent);
  }
  return { agents: agents.size, runs, ok, descendants: Math.max(0, nodes.length - 1) };
}

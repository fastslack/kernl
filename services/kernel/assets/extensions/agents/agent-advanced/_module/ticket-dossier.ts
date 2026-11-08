/**
 * Ticket dossiers — what an office already knows about each ticket, kept by Kernl and handed back to every run
 * that works on it again.
 *
 * Office agents come back to the same ticket many times (a fix, QA's objections, a failed job, the fix again) and
 * each run starts from zero: it re-reads the issue, the merge request and the code it read last time. That
 * re-exploration is most of what those runs cost. So when a run whose goal names tickets (`repo#123`, a sub-part
 * `repo#123:a-b` counts as its ticket) finishes, a cheap model merges what the run did and learned into one short
 * dossier per ticket — state, findings, files and commands, what was tried and dropped, what is pending — and
 * the next run that names that ticket starts from it, told not to re-explore what it already covers.
 *
 * A dossier belongs to an office (every agent of the office reads and feeds the same one) and a project. Runs that
 * did no work (a script tick, a run that died before its first step) update nothing. Kill switch:
 * AGENTS_TICKET_DOSSIERS=0. The model: AGENT_DOSSIER_MODEL (empty: the configured chain).
 */

/** A dossier's ceiling: about 450 tokens per ticket in a prompt. */
export const DOSSIER_MAX_CHARS = 1800;
/** At most this many tickets are updated after a run, and shown in one. */
const MAX_REFS_UPDATED = 4;
const MAX_REFS_SHOWN = 3;
/** Runs with fewer steps did no work worth remembering (script ticks, early deaths). */
const MIN_STEPS = 3;
/** How much of a run's result and error goes to the update. */
const MAX_RESULT_CHARS = 6000;

export interface Dossier { scope: string; project_id: string; ref: string; content: string; runs: number; last_run_id: string; updated_at: string }

export interface FinishedRun {
  /** The office (flow id), or the agent id when it has none. */
  scope: string;
  projectId: string | null;
  runId: string;
  agentName: string;
  goal: string;
  status: string;
  steps: number;
  result: string;
  error: string;
}

/** Asks a model; returns its text. */
export type Summarize = (prompt: { system: string; user: string }) => Promise<string>;

interface Db { exec(sql: string): unknown; prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } }

/** The tickets a text names, as `repo#number`, in order of appearance, once each. */
export function ticketRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(/(?<![\w./#-])([a-z][a-z0-9_-]{0,30})#(\d{1,7})(?![\w])/gi)) {
    const ref = `${m[1].toLowerCase()}#${m[2]}`;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

const SYSTEM = [
  "You keep the dossier of each ticket an office of software agents works on. After every run on a ticket you rewrite its dossier so the next run can start from it instead of re-reading the issue, the merge request and the code.",
  "Merge the previous dossier with what this run did and found. Keep what is still true, drop what the run proved wrong or outdated, add what is new.",
  "Write facts only, terse, in the language the run's result is written in, under these headings when there is something for them: Estado (state now, branch, commit, merge request, what the office waits for) · Hallazgos (cause, how the code works there) · Archivos y comandos (paths, functions, test commands that work) · Probado y descartado (and why) · Pendiente.",
  `At most ${DOSSIER_MAX_CHARS} characters per ticket. No greetings, no advice, nothing about other tickets.`,
  "Answer with ONE JSON object only: each key a ticket exactly as given, each value its whole new dossier as a string. Leave out a ticket the run did not touch.",
].join("\n");

/** The first JSON object in a model's answer (code fences and chatter around it allowed), or null. */
function readJson(text: string): Record<string, unknown> | null {
  const s = String(text ?? "");
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export class TicketDossiers {
  /** Updates of one dossier run one after the other, so two runs finishing together do not lose one. */
  private queue = new Map<string, Promise<unknown>>();

  constructor(private db: Db, private summarize: Summarize) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_ticket_dossiers (
      scope TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '', runs INTEGER NOT NULL DEFAULT 0, last_run_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL, PRIMARY KEY (scope, project_id, ref))`);
  }

  get(scope: string, projectId: string | null, ref: string): Dossier | null {
    return (this.db.prepare("SELECT * FROM agent_ticket_dossiers WHERE scope = ? AND project_id = ? AND ref = ?")
      .get(scope, projectId ?? "", ref) as Dossier | undefined) ?? null;
  }

  /** The prompt block for a run whose goal is `goal`: the dossiers of the tickets it names, or "" when none has one. */
  promptBlock(scope: string, projectId: string | null, goal: string): string {
    const found = ticketRefs(goal).map((r) => this.get(scope, projectId, r)).filter((d): d is Dossier => !!d && !!d.content.trim()).slice(0, MAX_REFS_SHOWN);
    if (!found.length) return "";
    return [
      "## What your office already knows about these tickets",
      "Kept by Kernl from the office's earlier runs on them. Start from it: do not re-read or re-explore what it already covers (the issue, the files, the cause, what was tried). " +
        "Check only what may have changed since: new letters, the merge request's state, a job's result. If something in it is wrong, say so in your result and it gets corrected.",
      ...found.map((d) => `### ${d.ref} — ${d.runs} run${d.runs === 1 ? "" : "s"}, updated ${d.updated_at.slice(0, 16).replace("T", " ")} UTC\n${d.content.trim()}`),
    ].join("\n\n");
  }

  /** Fold a finished run into the dossiers of the tickets its goal names. Returns how many were updated; never throws. */
  async afterRun(run: FinishedRun): Promise<number> {
    const refs = ticketRefs(run.goal).slice(0, MAX_REFS_UPDATED);
    const said = [run.result, run.error].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n\nError: ");
    if (!refs.length || run.steps < MIN_STEPS || !said) return 0;
    // Wait for any update still writing one of these tickets.
    const keys = refs.map((r) => `${run.scope}|${run.projectId ?? ""}|${r}`);
    const prev = Promise.all(keys.map((k) => (this.queue.get(k) ?? Promise.resolve()).catch(() => {})));
    const next = prev.then(() => this.update(run, refs, said));
    for (const k of keys) this.queue.set(k, next);
    try { return await next; } catch { return 0; } finally { for (const k of keys) if (this.queue.get(k) === next) this.queue.delete(k); }
  }

  private async update(run: FinishedRun, refs: string[], said: string): Promise<number> {
    const before = refs.map((r) => this.get(run.scope, run.projectId, r));
    const user = [
      `Tickets: ${refs.join(", ")}`,
      ...refs.map((r, i) => `Previous dossier of ${r}:\n${before[i]?.content.trim() || "(none yet)"}`),
      `This run (${run.agentName}, ${run.status}, ${run.steps} steps) was asked:\n${clip(run.goal, 1500)}`,
      `What it reported:\n${clip(said, MAX_RESULT_CHARS)}`,
    ].join("\n\n");
    let answer: string;
    try { answer = await this.summarize({ system: SYSTEM, user }); } catch { return 0; }
    const json = readJson(answer);
    if (!json) return 0;
    const now = new Date().toISOString();
    let n = 0;
    for (const ref of refs) {
      const v = json[ref];
      if (typeof v !== "string" || !v.trim()) continue;
      const content = clip(v.trim(), DOSSIER_MAX_CHARS);
      this.db.prepare(`INSERT INTO agent_ticket_dossiers (scope, project_id, ref, content, runs, last_run_id, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (scope, project_id, ref) DO UPDATE SET content = excluded.content, runs = agent_ticket_dossiers.runs + 1, last_run_id = excluded.last_run_id, updated_at = excluded.updated_at`)
        .run(run.scope, run.projectId ?? "", ref, content, run.runId, now);
      n++;
    }
    return n;
  }
}

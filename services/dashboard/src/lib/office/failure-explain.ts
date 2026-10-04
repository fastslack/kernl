/**
 * A failed run's error, read for the operator: what happened in plain words,
 * why, and the one control that fixes it. The kernel's own text stays on the
 * card too — this is the headline, not a replacement.
 *
 * A lookup table on purpose (see run-failure.ts for the drawer's version):
 * each row is an error the office actually receives. Titles and reasons are
 * i18n keys under `office.fail.*`; `params` fills their placeholders.
 */

export type FailureKind =
  | 'restart' | 'max_turns' | 'auth' | 'budget' | 'timeout' | 'errors'
  | 'provider' | 'rate' | 'unknown' | 'other';

/** What the fix button does. */
export type FailureFix = 'retry' | 'settings' | 'llm';

export interface FailureExplanation {
  kind: FailureKind;
  titleKey: string;
  whyKey: string;
  params: Record<string, string>;
  fix: FailureFix;
}

const row = (kind: FailureKind, fix: FailureFix, params: Record<string, string> = {}): FailureExplanation => ({
  kind, fix, params, titleKey: `office.fail.${kind}_title`, whyKey: `office.fail.${kind}_why`,
});

export function explainFailure(error: string | null | undefined): FailureExplanation {
  const text = String(error ?? '').trim();
  if (!text || /^failed\.?$/i.test(text)) return row('unknown', 'retry');
  if (/stale run cleaned up on startup/i.test(text)) return row('restart', 'retry');
  const turns = /maximum number of turns \((\d+)\)/i.exec(text);
  if (turns) return row('max_turns', 'settings', { n: turns[1] });
  if (/oauth session expired|failed to authenticate|not logged in|invalid[_ ]api[_ ]key|authentication/i.test(text)) return row('auth', 'llm');
  if (/token budget|max_tokens/i.test(text)) return row('budget', 'settings');
  if (/safety abort|consecutive errors|max_errors/i.test(text)) return row('errors', 'settings');
  if (/timed? ?out|timeout/i.test(text)) return row('timeout', 'settings');
  if (/no (available )?llm provider|can run tool calls/i.test(text)) return row('provider', 'llm');
  if (/\b429\b|rate.?limit|quota|exhausted|overloaded/i.test(text)) return row('rate', 'retry');
  return row('other', 'retry');
}

export interface RunContext {
  /** What the run set out to do: the goal's first meaningful line. */
  goal: string;
  trigger: string;
  steps: number;
  /** Wall-clock, or null when the run never started or never ended. */
  durationMs: number | null;
  /** The last thing it did before stopping: a tool name, or the start of a thought. */
  lastStep: string;
  /** The run's own error when the report only carried a status. */
  error: string;
}

type RunRow = {
  goal?: string; trigger_type?: string; steps_count?: number; error?: string | null;
  started_at?: string | null; completed_at?: string | null; created_at?: string;
};
type StepRow = { type?: string; tool_name?: string | null; content?: string | null };

/** GET /api/agents/runs/:id → the few facts a failure card needs. */
export function summarizeRunContext(run: RunRow, steps: StepRow[]): RunContext {
  const goal = String(run.goal ?? '')
    .split('\n').map((l) => l.trim()).find((l) => l && !/^[-=#*>]+$/.test(l)) ?? '';
  const start = Date.parse(run.started_at ?? run.created_at ?? '');
  const end = Date.parse(run.completed_at ?? '');
  const last = [...steps].reverse().find((s) => s.type === 'tool_call' || s.type === 'thought');
  const lastStep = !last
    ? ''
    : last.type === 'tool_call'
      ? String(last.tool_name ?? '').replace(/^mcp__.+?__/, '')
      : String(last.content ?? '').replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return {
    goal: goal.replace(/[*`]/g, '').slice(0, 200),
    trigger: String(run.trigger_type ?? ''),
    // A run cut short (kernel restart) never updates steps_count; its
    // recorded steps still say how far it got.
    steps: Math.max(Number(run.steps_count ?? 0) || 0, steps.length),
    durationMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
    lastStep,
    error: String(run.error ?? ''),
  };
}

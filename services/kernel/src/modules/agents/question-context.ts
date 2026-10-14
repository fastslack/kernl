/**
 * Everything about an escalated question that the investigator cannot get
 * from GitLab or the code: the question as asked (context untruncated), the
 * chief's reason, and what the asking agent was doing — its run's goal (the
 * letter it was working on) and its steps up to the question.
 */
import type { AgentQuestion } from "./service.js";
import type { AgentRun, AgentStep } from "./types.js";

const MAX_TOTAL = 60_000;
const MAX_STEP = 1_500;

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)} … (+${s.length - max})` : s;
}

/** The asker's run the question came from: the one recorded, else its last run started before it. */
export function askingRun(q: AgentQuestion, runs: AgentRun[]): AgentRun | undefined {
  if (q.run_id) {
    const exact = runs.find((r) => r.id === q.run_id);
    if (exact) return exact;
  }
  return runs
    .filter((r) => r.created_at <= q.created_at)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
}

export function formatQuestionContext(
  q: AgentQuestion,
  asker: { name: string; description?: string } | undefined,
  run: AgentRun | undefined,
  steps: AgentStep[],
): string {
  const lines = [
    `### Question ${q.id} (${q.status})`,
    `asked by: ${asker?.name ?? q.from_agent_id}${asker?.description ? ` — ${asker.description}` : ""} · ${q.created_at}`,
    "",
    `#### Question`,
    q.question,
  ];
  if (q.chief_note) lines.push("", "#### Why the chief escalated it", q.chief_note);
  lines.push("", "#### Options", ...q.options.map((o, i) => `${i + 1}. ${o.label}${o.value && o.value !== o.label ? ` (${o.value})` : ""}${o.url ? ` — ${o.url}` : ""}`));
  if (q.context) lines.push("", "#### Context (as the agent wrote it)", q.context);
  if (!run) {
    lines.push("", "#### The agent's run", "(not found)");
    return cut(lines.join("\n"), MAX_TOTAL);
  }
  lines.push("", `#### The agent's run ${run.id} (${run.status}, ${run.created_at})`, "Goal:", cut(run.goal ?? "", 8_000));
  const before = steps.filter((s) => !q.created_at || s.created_at <= q.created_at || steps.length <= 40);
  lines.push("", `Steps (${before.length}):`);
  for (const s of before) {
    if (s.type === "tool_call") lines.push(`- [${s.step_number}] call ${s.tool_name} ${cut(s.tool_input || "", MAX_STEP)}`);
    else if (s.type === "tool_result") lines.push(`- [${s.step_number}] result ${s.tool_name}: ${cut(s.tool_output || s.content || "", MAX_STEP)}`);
    else lines.push(`- [${s.step_number}] ${s.type}: ${cut(s.content || "", MAX_STEP)}`);
  }
  return cut(lines.join("\n"), MAX_TOTAL);
}

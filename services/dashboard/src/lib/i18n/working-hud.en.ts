// Strings of the 3D world's WORKING list (routes/agents-flow/WorkingHud.svelte).
const en = {
  "working.title": "Working",
  "working.office": "Office",
  "working.model": "Model",
  "working.running": "Running",
  "working.work": "Work",
  "working.tools": "{n} tools",
  "working.tokens": "{n} tok",
  "working.ago": "{t} ago",
  "working.open": "Open agent",
  "working.step.tool_call": "calling tool",
  "working.step.tool_result": "tool result",
  "working.step.thought": "thinking",
  "working.step.final": "finishing",
  "working.step.error": "error",
  "working.step.rate_limit_wait": "rate limited",
  "working.step.run_started": "run started",
  "working.step.run_completed": "run completed",
  "working.step.claude_account": "Claude account",
  "working.step.learning_recalled": "lessons recalled",
  "working.step.auto_eval_started": "self-grading",
} as const;

export type WorkingHudKey = keyof typeof en;
export default en;

/**
 * Turn a run's failure into a line the operator can act on.
 *
 * This lands in the agent's chat thread and is read later with no log beside
 * it, so it has to stand on its own. "Reached maximum number of turns (15)" is
 * accurate and tells a non-author nothing — not that it is a budget, not that
 * the work already on screen is real, not which setting moves it.
 *
 * Deliberately conservative: the original text is always kept, and advice is
 * added only for failures whose cause is unambiguous from the message. An
 * ordinary tool error passes through untouched rather than being buried under
 * a guess.
 */

/** Long enough for a stack-ish message, short enough not to flood a thread. */
const MAX_LEN = 900;

export function failureNote(error: string | undefined | null): string {
  const raw = (error ?? "").trim();
  if (!raw) {
    return "[Error] The run failed and reported no reason. Check History for the steps it managed before it died.";
  }

  const body = raw.length > MAX_LEN ? `${raw.slice(0, MAX_LEN)}…` : raw;
  const hint = hintFor(raw);
  return hint ? `[Error] ${body}\n\n${hint}` : `[Error] ${body}`;
}

function hintFor(raw: string): string {
  // The SDK words this several ways ("Reached maximum number of turns (15)",
  // "error_max_turns", "reached max turns (8)"); the count is what matters.
  if (/max(imum)?[ _]?(number of )?turns/i.test(raw)) {
    const n = raw.match(/\((\d+)\)/)?.[1];
    const budget = n ? `${n} step${n === "1" ? "" : "s"}` : "its step budget";
    return (
      `The agent ran out of steps — it used all ${budget} before finishing, so it stopped mid-task ` +
      `and never wrote an answer. Anything it had already done is real and saved. ` +
      `Raise \`max_iterations\` on the agent, or give it a smaller task; if it is spending a step ` +
      `per item, a tool that takes a batch will do far more within the same budget.`
    );
  }

  if (/credit balance|insufficient|billing|quota/i.test(raw)) {
    return "This is a billing or quota limit on the account behind the agent, not a fault in the task.";
  }

  if (/exited with code|terminated by signal|died with no output/i.test(raw)) {
    return (
      "The Claude Code subprocess died without explaining itself, which usually means authentication " +
      "or billing. Running the agent's command by hand shows the real reason — the CLI only reports " +
      "these interactively."
    );
  }

  return "";
}

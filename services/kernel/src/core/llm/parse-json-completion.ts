/**
 * Parse the JSON object an LLM was asked to return.
 *
 * `response_format: {type:"json_object"}` is a request, not a guarantee: local
 * servers vary in whether they honour it, and a model that ignores it answers
 * with the object wrapped in a sentence ("Here's the team: {…}"), or in a code
 * fence, or both. A bare `JSON.parse` fails on all of those even though the
 * object it needs is sitting right there, and the caller reports it as a model
 * that produced nothing usable.
 *
 * So: try the direct parse first — that is the overwhelmingly common case and
 * stays exact — and only when it fails go looking for the object. This can
 * turn a failure into a success and never the reverse.
 *
 * Extraction walks the string tracking string literals and escapes rather than
 * slicing between the first `{` and the last `}`. The naive slice is wrong the
 * moment a prompt inside the JSON contains a brace, which for this codebase is
 * routine — the drafts being parsed are full of agent prompts.
 *
 * Run `stripReasoning` before this; a reasoning block's prose is full of braces
 * and would otherwise be what extraction finds first.
 */

/** Both shapes an LLM might legitimately be asked for. */
const OPENERS: Record<string, string> = { "{": "}", "[": "]" };

/**
 * The first complete, balanced JSON value in `text`, or null when there is
 * none. Scans from each opener so a false start (an unterminated brace in
 * prose) does not prevent finding the real object later in the string.
 */
export function extractJsonValue(text: string): string | null {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    const close = OPENERS[open];
    if (!close) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { if (inString) escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    // Unbalanced from here on; try the next opener.
  }
  return null;
}

/** Strip a leading/trailing markdown fence, if the whole reply is fenced. */
function unfence(text: string): string {
  return text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
}

/**
 * Parse `text` as JSON, recovering an embedded object when the reply is not
 * pure JSON. Throws with a bounded excerpt of what actually came back, because
 * "Unexpected token < in JSON at position 0" tells the operator nothing about
 * which model misbehaved or how.
 */
export function parseJsonCompletion<T = unknown>(text: string): T {
  const cleaned = unfence(text);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall through to extraction.
  }
  const extracted = extractJsonValue(cleaned);
  if (extracted) {
    try {
      return JSON.parse(extracted) as T;
    } catch {
      // Extraction found a balanced value that still isn't valid JSON.
    }
  }
  const excerpt = cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
  throw new Error(`the model did not return JSON. It replied: ${excerpt || "(nothing)"}`);
}

/**
 * Strip "reasoning"/"thinking" blocks that reasoning models (MiniMax-M2.x,
 * DeepSeek-R1, Kimi, QwQ, etc.) emit BEFORE their actual answer.
 *
 * These blocks routinely contain `{`/`}` characters in their prose ("the agent
 * was supposed to {…}"), which breaks the common
 * `indexOf("{") … lastIndexOf("}")` JSON-extraction trick — the slice grabs a
 * brace from inside the reasoning instead of the real JSON object. Always run
 * this before parsing JSON out of an LLM completion.
 *
 * Handles the tag variants seen in the wild:
 *   <think>…</think>           (MiniMax, DeepSeek)
 *   <reasoning>…</reasoning>
 *   ◁think▷…◁/think▷           (Kimi)
 * Closed blocks are removed. A dangling, unclosed opener (truncated output)
 * has everything from the opener onward dropped — there's no answer after it.
 */
export function stripReasoning(text: string): string {
  if (!text) return text;
  let out = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/◁think▷[\s\S]*?◁\/think▷/gi, "");
  // Dangling unclosed opener (model ran out of tokens mid-reasoning).
  const open = out.search(/<think>|<reasoning>|◁think▷/i);
  if (open !== -1) out = out.slice(0, open);
  return out.trim();
}

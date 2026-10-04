/**
 * Parse an optional <msg role="..." replies_to="..."> wrapper produced by an
 * agent. The wrapper is stripped before the content is returned to the caller
 * agent; the role is stored on the conversation message for debate detection.
 *
 * Accepted shape (whitespace tolerant):
 *   <msg role="counter" replies_to="abcd-..."> body... </msg>
 *
 * Returns the role string if the tag exists and role is a recognised value,
 * else null (caller falls back to 'answer' or 'stmt').
 */
export function extractRoleFromReply(text: string):
  "stmt" | "question" | "answer" | "counter" | "vote" | "summary" | null {
  if (!text) return null;
  const m = text.match(/<msg\b[^>]*\brole\s*=\s*"([a-z]+)"/i);
  if (!m) return null;
  const r = m[1].toLowerCase();
  if (r === "stmt" || r === "question" || r === "answer" || r === "counter" || r === "vote" || r === "summary") {
    return r;
  }
  return null;
}

/** Strip a leading/trailing <msg ...>...</msg> wrapper if present; return body. */
export function stripRoleWrapper(text: string): string {
  if (!text) return text;
  const m = text.match(/^\s*<msg\b[^>]*>([\s\S]*?)<\/msg>\s*$/i);
  if (m) return m[1].trim();
  return text;
}

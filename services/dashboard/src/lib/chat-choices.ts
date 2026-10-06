/**
 * Clickable answers in the agent chat.
 *
 * When an agent needs the operator to pick between paths it ends its reply
 * with a fenced block (the format is asked for in the chat goal):
 *
 *   ```choices
 *   {"question": "¿Qué querés hacer?", "options": ["A", "B", "C"]}
 *   ```
 *
 * The block is cut out of the text before rendering and drawn as buttons, the
 * same way the chief's pinned questions are. Anything that doesn't parse is
 * left in the text untouched — a malformed block reads as code, never vanishes.
 */

export interface ChatChoices {
  question: string;
  options: string[];
}

export const MAX_CHOICES = 6;

const BLOCK = /```choices[ \t]*\n([\s\S]*?)\n?```/i;

function labelOf(o: unknown): string {
  if (typeof o === 'string') return o.trim();
  if (o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string') {
    return (o as { label: string }).label.trim();
  }
  return '';
}

/** Split a reply into the prose to render and the choices to offer, if any. */
export function extractChoices(text: string | null | undefined): { body: string; choices: ChatChoices | null } {
  const src = text ?? '';
  const m = BLOCK.exec(src);
  if (!m) return { body: src, choices: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return { body: src, choices: null };
  }
  const raw = Array.isArray(parsed) ? parsed : (parsed as { options?: unknown })?.options;
  if (!Array.isArray(raw)) return { body: src, choices: null };
  const options = [...new Set(raw.map(labelOf).filter(Boolean))].slice(0, MAX_CHOICES);
  if (options.length < 2) return { body: src, choices: null };
  const q = Array.isArray(parsed) ? '' : (parsed as { question?: unknown }).question;
  const body = (src.slice(0, m.index) + src.slice(m.index + m[0].length)).trim();
  return { body, choices: { question: typeof q === 'string' ? q.trim() : '', options } };
}

/** The reply as prose — for speech and copy, where the JSON is noise. */
export function choicesAsText(text: string | null | undefined): string {
  const { body, choices } = extractChoices(text);
  if (!choices) return body;
  const list = choices.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  return [body, choices.question, list].filter(Boolean).join('\n\n');
}

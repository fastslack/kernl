/**
 * The work item a text names first: `web#2653:a-b` (an issue and its part),
 * `api#12`, or '' — the key decisions and runs are filed under. A letter's
 * subject ("TRABAJAR web#2653") puts it in a run's goal, and a question names
 * it in its text.
 */
export function subjectKeyOf(text: string): string {
  const m = /(?<![\w/!#])([a-z][a-z0-9_-]{0,40}#\d{1,7}(?::[\w-]{1,40})?)/i.exec(text);
  return m ? m[1].toLowerCase() : "";
}

/** The issue a part belongs to: `web#2653:a-b` → `web#2653`; an issue is its own root. */
export function subjectRootOf(key: string): string {
  return key.split(":")[0];
}

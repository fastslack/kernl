/**
 * Calendar titles in the agenda language. The triage is asked to write them that way (agendaPromptRules), but items
 * written before that rule — and any the model leaves in the mail's language — get one more pass here: a batch of
 * unchecked titles goes to the mail model in one call, the changed ones are rewritten in place, and each is marked
 * checked so it is never sent again. A failed call or an answer that does not line up changes nothing.
 */
import type { SqliteDb } from "@kernl/extension-sdk";

const TABLES = new Set(["events", "tasks", "reminders"]);

/** The array of strings in the model's answer (it may think aloud or fence the JSON first): the last one that parses. */
export function stringArray(raw: string): string[] | null {
  const text = raw.replace(/```(?:json)?/gi, "");
  for (let end = text.lastIndexOf("]"); end !== -1; end = text.lastIndexOf("]", end - 1)) {
    for (let start = text.lastIndexOf("[", end); start !== -1; start = text.lastIndexOf("[", start - 1)) {
      try {
        const v = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
      } catch { /* not this span */ }
    }
  }
  return null;
}

export async function translateAgendaTitles(
  db: SqliteDb,
  chat: (system: string, user: string) => Promise<string>,
  language: string,
  limit = 40,
): Promise<number> {
  const links = db.prepare("SELECT id, local_table, local_id FROM mail_agenda_links WHERE title_checked = 0 ORDER BY created_at LIMIT ?")
    .all(limit) as Array<{ id: string; local_table: string; local_id: string }>;
  const items: Array<{ link: string; table: string; id: string; title: string }> = [];
  const markChecked = db.prepare("UPDATE mail_agenda_links SET title_checked = 1 WHERE id = ?");
  for (const l of links) {
    const row = TABLES.has(l.local_table)
      ? (db.prepare(`SELECT title FROM ${l.local_table} WHERE id = ?`).get(l.local_id) as { title: string } | undefined)
      : undefined;
    if (row?.title) items.push({ link: l.id, table: l.local_table, id: l.local_id, title: row.title });
    else markChecked.run(l.id); // the calendar row is gone: nothing to translate
  }
  if (!items.length) return 0;

  let answer: string[] | null;
  try {
    answer = stringArray(await chat(
      `Translate each calendar title to ${language}. Keep names, places, codes and numbers as they are. ` +
      `A title already in ${language} comes back unchanged. Answer ONLY with a JSON array of strings, same order and length.`,
      JSON.stringify(items.map((i) => i.title)),
    ));
  } catch {
    return 0;
  }
  if (!answer || answer.length !== items.length) return 0;

  let changed = 0;
  db.transaction(() => {
    items.forEach((it, i) => {
      const t = typeof answer![i] === "string" ? (answer![i] as string).trim().slice(0, 160) : "";
      if (t && t !== it.title) {
        db.prepare(`UPDATE ${it.table} SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(t, it.id);
        changed++;
      }
      markChecked.run(it.link);
    });
  })();
  return changed;
}

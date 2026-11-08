/**
 * What a run always fetches first, handed to it already fetched.
 *
 * Office runs open the same way every time: `kernel_agents_inbox` for the letters the goal names (the goal says
 * they are in context; for claude_code agents they were not), `kernel_agents_directory` to find a colleague's exact
 * name, and the same skill files (`kernel_skill_load`). Each of those is a turn, and every turn re-reads the whole
 * context. So the run gets, in its prompt:
 *   - the letters its goal names (subject, sender, id, body — long bodies cut);
 *   - its office's directory with the exact names and ids to write to;
 *   - the skill files it loaded in most of its recent runs of the same kind of letter (learned from its steps).
 * Opt out per agent with the variable `__prefetch__: false`.
 */

/** A skill file is prefetched when it was loaded in this share of the recent runs (and in MIN_RUNS of them). */
const SHARE = 0.8;
const MIN_RUNS = 3;
const LETTER_MAX = 3000;
const LETTERS_MAX = 12000;
const SKILL_MAX = 8000;

export interface PrefetchLetter { id: string; subject: string; body: string; from: string }
export interface PrefetchSkill { slug: string; file?: string; text: string }

/** The letter ids a wake goal names: `(id <uuid>)`. */
export function letterIds(goal: string): string[] {
  return [...String(goal ?? "").matchAll(/\(id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi)].map((m) => m[1]);
}

/** From the steps of an agent's recent runs (`runs` of them): the skill files it loads in most of them. */
export function learnSkillPrefetch(steps: Array<{ run_id: string; tool_name: string | null; tool_input: string | null }>, runs: number): Array<{ slug: string; file?: string }> {
  if (runs < MIN_RUNS) return [];
  const seen = new Map<string, Set<string>>();
  for (const s of steps) {
    if (!/(^|__)kernel_skill_load$/.test(String(s.tool_name ?? ""))) continue;
    let input: { slug?: unknown; file?: unknown };
    try { input = JSON.parse(String(s.tool_input ?? "")); } catch { continue; }
    if (typeof input?.slug !== "string" || !input.slug) continue;
    const key = JSON.stringify([input.slug, typeof input.file === "string" ? input.file : ""]);
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key)!.add(s.run_id);
  }
  const out: Array<{ slug: string; file?: string }> = [];
  for (const [key, ids] of seen) {
    if (ids.size < MIN_RUNS || ids.size / runs < SHARE) continue;
    const [slug, file] = JSON.parse(key) as [string, string];
    out.push(file ? { slug, file } : { slug });
  }
  return out;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut: ${s.length - n} more characters; kernel_agents_inbox has the whole letter)` : s);

/** The prompt block, or "" when there is nothing to hand. */
export function prefetchBlock(p: { letters: PrefetchLetter[]; directory: Array<{ name: string; id: string }>; skills: PrefetchSkill[] }): string {
  const parts: string[] = [];
  if (p.letters.length) {
    let room = LETTERS_MAX;
    const shown = p.letters.map((l) => {
      const body = cut(String(l.body ?? "").trim(), Math.max(400, Math.min(LETTER_MAX, room)));
      room -= body.length;
      return `### "${l.subject}" — from ${l.from} (id ${l.id})\n${body}`;
    });
    parts.push("## Your letters (already loaded: do not call kernel_agents_inbox for them)\n" +
      "Acknowledge each one you finish with kernel_agents_inbox_ack({ message_ids: [...] }).\n\n" + shown.join("\n\n"));
  }
  if (p.directory.length) {
    parts.push("## Your office (exact names and ids: do not call kernel_agents_directory)\n" +
      "Write to a colleague with kernel_agents_post_to_colleague using one of these names or ids exactly.\n" +
      p.directory.map((d) => `- ${d.name} — ${d.id}`).join("\n"));
  }
  for (const s of p.skills) {
    parts.push(`## Skill ${s.slug}${s.file ? ` · ${s.file}` : ""} (already loaded: do not fetch it again with kernel_skill_load)\n${cut(s.text.trim(), SKILL_MAX)}`);
  }
  return parts.join("\n\n");
}

/**
 * Skill scoring — keyword overlap weighted by IDF. Pure: no DB, no ctx.
 *
 * Extracted from skill-suggester.ts, which kept all of this private to a cron
 * handler. Two consumers need the same maths now: the daily suggester and the
 * per-agent endpoint the drawer's SKILLS tab calls. Being pure also means it
 * can be proven without standing up a kernel, which the original never was.
 *
 * Why not an LLM: skill-suggester.ts:6 records the attempt — matching agents
 * against a large skill inventory burned ~500k tokens and invented skills.
 */

// ── Tokenisation + IDF scoring ────────────────────────────────

// Bilingual stopword list. Tuned to the kernel's voice (mix EN/ES) and to
// strip kernel-domain noise words ("agent", "tool", "kernel") that would
// otherwise match every skill.
const STOPWORDS = new Set([
  // English
  "the","a","an","and","or","but","of","to","in","on","for","is","at","by","with","as","from",
  "that","this","be","are","was","were","you","your","when","then","what","which","who","how","why",
  "not","no","do","does","done","its","it","has","have","had","into","over","under","also",
  // Spanish
  "el","la","los","las","de","del","y","o","en","con","por","para","un","una","es","son","ser",
  "como","cuando","entonces","que","cual","quien","si","se","su","sus","les","les","esa","ese",
  // Kernel-domain noise
  "use","using","used","get","got","run","runs","call","calls","tool","tools",
  "agent","agents","kernel","skill","skills","script","handler","module","modules",
  "when","also","etc","just","only","very","first","next","more","most","best",
]);

export function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export function computeIdf(skillTokens: Map<string, Set<string>>, N: number): Map<string, number> {
  // df[token] = # of skills that contain it.
  const df = new Map<string, number>();
  for (const tokens of skillTokens.values()) {
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // Smoothed IDF — log((N+1)/(df+1)) + 1, never goes negative, never zero.
  const idf = new Map<string, number>();
  for (const [t, n] of df) {
    idf.set(t, Math.log((N + 1) / (n + 1)) + 1);
  }
  return idf;
}

function scoreSkill(
  agentTokens: Set<string>,
  skillTokens: Set<string>,
  idf: Map<string, number>,
  skillSlug: string,
  agentBlob: string,
): { score: number; matches: string[] } {
  const matched: string[] = [];
  let s = 0;
  for (const t of skillTokens) {
    if (agentTokens.has(t)) {
      const w = idf.get(t) ?? 1;
      s += w;
      matched.push(t);
    }
  }
  // Slug appears verbatim in the agent's prompt/description → strong signal.
  // Often happens when the user already mentions the skill but hasn't attached it.
  if (skillSlug.length >= 4 && agentBlob.toLowerCase().includes(skillSlug.toLowerCase())) {
    s += 5;
    matched.unshift(`slug:${skillSlug}`);
  }
  return { score: s, matches: matched.slice(0, 5) };
}

// ── Row text builders ──────────────────────────────────────────

export function skillRowText(row: { slug: string; name: string; manifest_json: string }): string {
  let desc = ""; let longDesc = "";
  try {
    const m = JSON.parse(row.manifest_json || "{}");
    desc = typeof m.description === "string" ? m.description : "";
    longDesc = typeof m.long_description === "string" ? m.long_description : "";
  } catch { /* ignore */ }
  return `${row.slug} ${row.name} ${desc} ${longDesc}`;
}

export function agentRowText(row: {
  name: string;
  description: string;
  system_prompt: string;
  flow_name: string | null;
}): string {
  // Cap the system_prompt — operator prompts can be 5-10k chars; the
  // useful signal is in the first ~2k (role, domain, stack).
  const sp = (row.system_prompt || "").slice(0, 2000);
  return `${row.name} ${row.description || ""} ${sp} ${row.flow_name || ""}`;
}

// ── Composer ────────────────────────────────────────────────────

export interface ScorableSkill {
  slug: string;
  /** Everything about the skill worth matching on, already concatenated. */
  text: string;
}

export interface ScorableAgent {
  /** Name + description + capped system prompt + office name. */
  text: string;
  /** Slugs already attached — never suggested back. */
  attached: Set<string>;
}

export interface SkillMatch {
  slug: string;
  score: number;
  /** Up to 5 tokens that drove the score, for the "por qué" column. */
  matches: string[];
}

/**
 * Rank `skills` by how well they match `agent`, best first.
 *
 * IDF is computed over the candidate set handed in, so a token that is common
 * across this particular inventory weighs less — which is what keeps generic
 * words like "deploy" from dominating when half the catalogue mentions them.
 */
export function rankSkillsForAgent(
  agent: ScorableAgent,
  skills: ScorableSkill[],
  opts?: { minScore?: number; topN?: number },
): SkillMatch[] {
  const minScore = opts?.minScore ?? 0;
  const topN = opts?.topN ?? Number.MAX_SAFE_INTEGER;

  const skillTokens = new Map<string, Set<string>>();
  for (const s of skills) skillTokens.set(s.slug, new Set(tokenize(s.text)));

  const idf = computeIdf(skillTokens, skills.length);
  const agentTokens = new Set(tokenize(agent.text));

  return skills
    .filter((s) => !agent.attached.has(s.slug))
    .map((s) => {
      const { score, matches } = scoreSkill(
        agentTokens,
        skillTokens.get(s.slug) ?? new Set(),
        idf,
        s.slug,
        agent.text,
      );
      return { slug: s.slug, score, matches };
    })
    .filter((m) => m.score > 0 && m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

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

// Bilingual stopword list. Function words, pronouns, auxiliaries and the
// connective adverbs/verbs that every prompt uses ("cada", "siempre", "antes",
// "every", "before") carry no topic. They matter more than they look: the
// catalogue is mostly English, so a Spanish function word appears in only a
// handful of skills and IDF would rate it as rare — i.e. as a strong match —
// pairing every Spanish-prompted agent with whichever Spanish skills exist.
// Kernel-domain noise words ("agent", "tool", "kernel") match every skill too.
const STOPWORDS = new Set(`
the a an and or but of to in on for is at by with as from that this these those be been being are
was were you your yours we our ours they them their theirs he she his her him it its itself i me my
mine when then than what which who whom whose how why where while not no nor do does did done doing
has have had having into onto over under also can could would should will shall may might must
about above after again against all any anything anyone both each every everything few further here
there just more most other others own same so some something such too very only once until upon via
before during through below between out off up down now never always ever yet still already even
well much many lot lots one two three first last next new old per own etc e.g i.e say says said tell
make makes made take takes give gives see look keep let want need needs like want get gets got set
put way thing things case cases kind sure exactly short long back start end same different
el la lo los las de del al y e o u ni en con sin por para un una unos unas uno es son ser sea sean
era eran fue fueron sido siendo está están estar estaba estado estás estoy hay haber ha han he has
había hace hacer hacé hacen hecho como cuando entonces que qué cual cuál cuales quien quién quienes
si sí no se su sus le les lo me mi mis te tu tus tú vos usted ustedes nos nosotros ellos ellas él
ella esto esta este estos estas eso esa ese esos esas aquel aquella ahí aquí allí acá más menos muy
mucho muchos mucha muchas poco pocos tan tanto todo toda todos todas nada nadie algo alguien alguno
alguna algunos algunas ningún ninguno ninguna otro otra otros otras mismo misma mismos mismas cada
siempre nunca jamás antes después luego ahora ya aún todavía solo sólo sola solos también tampoco
pero sino aunque porque pues mientras donde dónde hasta desde hacia entre sobre bajo tras contra
según durante mediante vez veces cosa cosas caso casos tipo forma manera parte lado bien mal puede
pueden poder debe deben tiene tienen tener tenés va van ir da dar dice decir ver vas sale lleva
pasa pasó falta quedó queda dejá sos estás querés podés corresponde cualquier igual primero primera
último última nuevo nueva cero uno dos tres
use using used run runs call calls tool tools agent agents kernel skill skills script handler
module modules best operator operador office oficina oficinas corrida corridas run cómo
`.split(/\s+/).filter(Boolean));

export function tokenize(text: string): string[] {
  // Unicode-aware: keep any letter/number in any script (\p{L} / \p{N}),
  // not just a-z0-9. The old ASCII-only class treated an accented letter as
  // a separator, so "diseño" split into "dise" + "o" and the length filter
  // below then dropped both — silently shredding every accented Spanish
  // content word (this office's agents are prompted in Spanish). Widening
  // the class rather than folding accents to base letters (diseño→diseno)
  // avoids inventing accidental collisions between unrelated words that
  // only look alike once stripped (e.g. "año" → "ano" is a different word).
  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}_\-\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !t.startsWith("kernel_"));
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

function slugPattern(slug: string): RegExp {
  const escaped = slug.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}($|[^\\p{L}\\p{N}_-])`, "iu");
}

function scoreSkill(
  agentTokens: Set<string>,
  agentNorm: number,
  skillTokens: Set<string>,
  idf: Map<string, number>,
  skillSlug: string,
  agentBlob: string,
): { score: number; matches: string[] } {
  // Cosine similarity of the two IDF-weighted token sets, scaled to 0-100.
  // A raw sum of matched weights grows with the skill's length: a skill
  // with a 3,000-word manual matched something in every agent and topped
  // every list. Dividing by both norms makes the score "what share of the
  // two vocabularies is shared", so a short, on-topic skill can win.
  const matched: Array<[string, number]> = [];
  let dot = 0;
  let skillNorm = 0;
  for (const t of skillTokens) {
    const w = idf.get(t) ?? 1;
    skillNorm += w * w;
    if (agentTokens.has(t)) {
      dot += w * w;
      matched.push([t, w]);
    }
  }
  let s = agentNorm > 0 && skillNorm > 0 ? (100 * dot) / (Math.sqrt(agentNorm) * Math.sqrt(skillNorm)) : 0;
  matched.sort((x, y) => y[1] - x[1]);
  const matches = matched.map(([t]) => t);
  // The slug named in the agent's prompt → strong signal: the operator
  // already mentions the skill but has not attached it. Only a compound slug
  // ("security-audit") counts, matched as a whole word: a one-word slug such
  // as "memo" or "status" is an ordinary word (and a substring of "memoria"),
  // and it already scores through the token overlap above.
  if (skillSlug.includes("-") && slugPattern(skillSlug).test(agentBlob)) {
    s += 20;
    matches.unshift(`slug:${skillSlug}`);
  }
  return { score: s, matches: matches.slice(0, 5) };
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
  opts?: {
    minScore?: number;
    topN?: number;
    /**
     * Texts of every agent on the instance (agentRowText). A word most agent
     * prompts share — the house style: "máximo", "revisar", "archivo",
     * "summary" — says nothing about what THIS agent does, so it is weighed
     * down by its frequency across agents, the same way IDF weighs down a
     * word most skills share. Absent → skill-side IDF only.
     */
    agentCorpus?: string[];
    /**
     * slug → cosine similarity of meaning (skill-vectors.ts). When given, it
     * leads the score (×100) and keyword overlap only adds a quarter of its
     * own score on top — so a skill written in another language than the
     * agent's prompt can still rank, which keywords alone never allow.
     */
    semantic?: Map<string, number>;
  },
): SkillMatch[] {
  const minScore = opts?.minScore ?? 0;
  const topN = opts?.topN ?? Number.MAX_SAFE_INTEGER;

  const skillTokens = new Map<string, Set<string>>();
  for (const s of skills) skillTokens.set(s.slug, new Set(tokenize(s.text)));

  const idf = computeIdf(skillTokens, skills.length);
  const corpus = opts?.agentCorpus ?? [];
  if (corpus.length > 1) {
    const agentDocs = new Map<string, Set<string>>();
    corpus.forEach((text, i) => agentDocs.set(String(i), new Set(tokenize(text))));
    const agentIdf = computeIdf(agentDocs, corpus.length);
    for (const [t, w] of idf) idf.set(t, w * (agentIdf.get(t) ?? Math.log(corpus.length + 1) + 1));
  }
  const agentTokens = new Set(tokenize(agent.text));
  // Tokens no candidate uses cannot match anything; leaving them out of the
  // norm keeps an agent's long prompt from diluting every score equally.
  let agentNorm = 0;
  for (const t of agentTokens) {
    const w = idf.get(t);
    if (w !== undefined) agentNorm += w * w;
  }

  return skills
    .filter((s) => !agent.attached.has(s.slug))
    .map((s) => {
      const { score, matches } = scoreSkill(
        agentTokens,
        agentNorm,
        skillTokens.get(s.slug) ?? new Set(),
        idf,
        s.slug,
        agent.text,
      );
      const sem = opts?.semantic;
      if (!sem) return { slug: s.slug, score, matches };
      const cos = sem.get(s.slug);
      if (cos === undefined) return { slug: s.slug, score: 0, matches };
      return { slug: s.slug, score: 100 * Math.max(cos, 0) + 0.25 * score, matches };
    })
    .filter((m) => m.score > 0 && m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

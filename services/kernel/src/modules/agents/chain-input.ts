/**
 * Accepting a model chain from the outside.
 *
 * `agents.update` (RPC) and `PUT /api/agents/:id` were the only writer the
 * dashboard has, and neither one read `model_chain` or `executor_type` — the
 * two columns an agent's runtime panel most needs to change. The chain could
 * only be written through `POST /api/agents/:id/model-chain`, which is not a
 * plain column write: it forces `executor_type` to `claude_code` and *clears*
 * the chain whenever the head is the SDK shim, and forces it back to `native`
 * otherwise. Useful as a one-click engine switch, wrong as the writer behind
 * an ordered list the user is editing row by row.
 *
 * So the two general writers now take both columns, and this is where the
 * value they are handed is made safe. The column is TEXT holding a JSON
 * array; a caller may send either the array or the serialised string it will
 * become, because the panel reads the column as a string and sending back
 * exactly what it read is the shape that cannot drift.
 */

export interface ModelChainEntry {
  provider: string;
  model: string;
}

/** Primary + two fallbacks — what the executor walks. */
export const MAX_MODEL_CHAIN = 3;

function entryOf(raw: unknown): ModelChainEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const provider = typeof r.provider === "string" ? r.provider : "";
  const model = typeof r.model === "string" ? r.model : "";
  // A row with neither is not a fallback, it is a blank the caller left
  // behind; the executor filters it out anyway (service.ts:421).
  if (!provider && !model) return null;
  return { provider, model };
}

/**
 * The chain to persist, or `undefined` for "the caller said nothing".
 *
 * `undefined` and "not present" have to stay distinguishable: `updateAgent`
 * only writes the columns it was given, and a malformed value must not be
 * read as "clear the chain". An explicit empty array or empty string does
 * mean clear it — that is how a chain collapses back to the loose pair.
 */
export function normalizeModelChainInput(value: unknown): ModelChainEntry[] | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const raw = value.trim();
    if (raw === "") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!Array.isArray(parsed)) return undefined;
    return parsed.map(entryOf).filter((e): e is ModelChainEntry => e !== null).slice(0, MAX_MODEL_CHAIN);
  }

  if (Array.isArray(value)) {
    return value.map(entryOf).filter((e): e is ModelChainEntry => e !== null).slice(0, MAX_MODEL_CHAIN);
  }

  return undefined;
}

/** The executor engine, or `undefined` for anything that is not one of the two. */
export function normalizeExecutorType(value: unknown): "native" | "claude_code" | undefined {
  return value === "native" || value === "claude_code" ? value : undefined;
}

/**
 * Accepting the procedural-skill slug list from the outside.
 *
 * Same job as the chain normalizer above, for the other column the agent
 * drawer writes. `agents.update` was building an explicit key list and
 * `skills` was not on it, so every attach made through the RPC — which is
 * the normal path, the dashboard only falls back to HTTP when its socket is
 * down — was dropped in silence while the UI reported success.
 *
 * It is validated rather than passed through because `skills_json` is not
 * inert storage. `service.updateAgent` JSON.stringifies whatever it is given,
 * and from there each slug travels two ways:
 *
 *   - back to the dashboard, where `parseAttachedSkills` runs `String()` over
 *     every member. A non-string element would come back as an unmatchable
 *     slug (`"[object Object]"`, `"null"`) and be reported forever as an
 *     orphaned skill the user cannot detach by name.
 *   - into the agent's own system prompt: `SkillBodyResolver.buildPromptIndex`
 *     writes `- **<slug>** — <description>` per attached slug on every run.
 *     An unbounded string from an untrusted caller is prompt surface, so the
 *     length cap is the point of it, not tidiness.
 *
 * SQL injection is not among the risks — the slug only ever reaches the DB as
 * a bound parameter — which is why this trims and drops instead of rejecting
 * the whole write.
 */

/** How many skills one agent may carry. Far above any real use; a stop, not a budget. */
export const MAX_AGENT_SKILLS = 64;
/** Longest slug accepted. Extension slugs are directory names. */
const MAX_SKILL_SLUG_LEN = 128;

/**
 * The slug list to persist, or `undefined` for "the caller said nothing".
 *
 * Same contract as `normalizeModelChainInput`: `undefined` must stay
 * distinguishable from `[]`, because `updateAgent` writes only the keys it is
 * given and a value it cannot read must not be taken as "detach everything".
 * An explicit empty array does mean detach everything.
 */
export function normalizeSkillsInput(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const slug = raw.trim();
    if (!slug || slug.length > MAX_SKILL_SLUG_LEN) continue;
    // A repeated slug bills twice in the drawer's token estimate and repeats
    // its line in the prompt index. Once is the only meaningful answer.
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= MAX_AGENT_SKILLS) break;
  }
  return out;
}

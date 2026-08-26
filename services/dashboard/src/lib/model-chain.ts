/**
 * The agent's model chain, as one list instead of two columns.
 *
 * `agents` stores a loose (provider, model) pair AND a `model_chain` JSON
 * array, where an empty chain means "use the loose pair" (types.ts:27-39).
 * That is a schema detail; the person editing an agent should see one ordered
 * list — primary first, then fallbacks — so the conversion lives here and
 * nowhere else.
 *
 * Writing a chain also mirrors its head into the loose pair on purpose:
 * executor.ts:640 documents that `provider` is kept for downstream code, so
 * leaving it stale would make the rest of the kernel disagree with the UI.
 */

export interface ChainLink {
  provider: string;
  model: string;
}

/** Primary + two fallbacks. What the executor uses today. */
export const MAX_CHAIN_LINKS = 3;

function isUsable(link: unknown): link is ChainLink {
  if (!link || typeof link !== "object") return false;
  const l = link as { provider?: unknown; model?: unknown };
  const provider = typeof l.provider === "string" ? l.provider : "";
  const model = typeof l.model === "string" ? l.model : "";
  return provider !== "" || model !== "";
}

function normalize(link: ChainLink): ChainLink {
  return { provider: link.provider ?? "", model: link.model ?? "" };
}

/**
 * The chain as the user should see it. A malformed `model_chain` degrades to
 * the loose pair rather than throwing — a corrupt column must not blank the
 * panel, and the loose pair is the older, more reliable of the two.
 */
export function readChain(agent: {
  provider?: string;
  model?: string;
  model_chain?: string;
}): ChainLink[] {
  const loose: ChainLink[] =
    agent.provider || agent.model
      ? [{ provider: agent.provider ?? "", model: agent.model ?? "" }]
      : [];

  const raw = agent.model_chain ?? "";
  if (!raw) return loose;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return loose;
  }
  if (!Array.isArray(parsed)) return loose;

  const links = parsed.filter(isUsable).map(normalize).slice(0, MAX_CHAIN_LINKS);
  return links.length > 0 ? links : loose;
}

/** The three columns to persist for a given list. */
export function writeChain(links: ChainLink[]): {
  provider: string;
  model: string;
  model_chain: string;
} {
  const usable = links.filter(isUsable).map(normalize).slice(0, MAX_CHAIN_LINKS);

  if (usable.length === 0) return { provider: "", model: "", model_chain: "" };

  const head = usable[0];
  if (usable.length === 1) {
    return { provider: head.provider, model: head.model, model_chain: "" };
  }
  return {
    provider: head.provider,
    model: head.model,
    model_chain: JSON.stringify(usable),
  };
}

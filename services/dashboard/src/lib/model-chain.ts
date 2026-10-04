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
 *
 * Non-string provider/model values coerce to `""`, not `String(v)`, because
 * the executor uses `""` as the sentinel for "not configured" (executor.ts:565's
 * `entry.provider || this.defaultProvider` fallback). Corrupted values like
 * `{provider: true, model: true}` become `{provider: "", model: ""}` and
 * correctly fail isUsable, allowing readChain to degrade to the loose pair.
 */

export interface ChainLink {
  provider: string;
  model: string;
}

/** Primary + two fallbacks. What the executor uses today. */
export const MAX_CHAIN_LINKS = 3;

function isUsable(link: unknown): boolean {
  if (!link || typeof link !== "object") return false;
  const l = link as { provider?: unknown; model?: unknown };
  const provider = typeof l.provider === "string" ? l.provider : "";
  const model = typeof l.model === "string" ? l.model : "";
  return provider !== "" || model !== "";
}

function normalize(link: unknown): ChainLink {
  const l = link as { provider?: unknown; model?: unknown };
  const provider = typeof l.provider === "string" ? l.provider : "";
  const model = typeof l.model === "string" ? l.model : "";
  return { provider, model };
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

/**
 * Can the claude_code executor run this link? It hands the model to the
 * Claude Code CLI, which only knows Claude models: given "MiniMax-M3" it
 * answers "There's an issue with the selected model" and every run of the
 * agent fails on its first turn. A Claude provider, or a model named claude-*,
 * is fine; an empty model on a Claude provider means its default.
 */
export function runsOnClaudeCode(link: ChainLink): boolean {
  const provider = link.provider.toLowerCase().replace(/[^a-z]/g, "");
  if (link.model) return /^claude/i.test(link.model) || /^(opus|sonnet|haiku)\b/i.test(link.model);
  return provider === "claudecode" || provider === "claude" || provider === "anthropic" || provider === "";
}

/**
 * The fields to write when `link` becomes an agent's primary model. Picking a
 * model the claude_code executor cannot run moves the agent to the kernel's
 * own executor in the same write, which runs any provider in the chain —
 * otherwise the pick is saved and silently never used.
 */
export function primaryModelPatch(
  agent: { executor_type?: string },
  chain: ChainLink[],
  link: ChainLink,
): Record<string, string> {
  const fields: Record<string, string> = writeChain([link, ...chain.slice(1)]);
  if (agent.executor_type === "claude_code" && !runsOnClaudeCode(link)) fields.executor_type = "native";
  return fields;
}

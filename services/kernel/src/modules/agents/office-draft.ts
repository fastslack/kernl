/**
 * "Armar con IA": turn the operator's description of a team into an
 * OfficeDefinition the wizard can prefill. Nothing is created here — the
 * operator still reviews and founds the office.
 *
 * The model call is injected (`chatJson`) so this runs in tests without a
 * bootstrapped kernel; the route passes `llm().chatJson`.
 */
import type { KernelLanguage } from "../../core/config.js";
import { FLOW_KINDS, type FlowKind } from "./types.js";
import type { LlmChatOptions } from "../../core/llm/client.js";
import { officeDefinitionFromJson, type OfficeDefinition } from "./office-kit.js";

export type ChatJson = (opts: LlmChatOptions) => Promise<unknown>;

/** One agent as the wizard gets to see it — a whitelisted, editable subset of
 *  `OfficeAgentSpec`. No `slug` (derived at POST time from the final office
 *  name) and `chainTo` holds agent NAMEs, not slugs (see `draftOfficeDefinition`). */
export interface OfficeDraftAgent {
  name: string;
  role?: "manager" | "worker";
  description?: string;
  prompt: string;
  chainTo?: string[];
}

/** What "Armar con IA" hands back for the operator to review and found —
 *  deliberately NOT the full `OfficeDefinition`: no repo, isolation, model
 *  chain, discipline, preview URL, defaults, or any per-agent executor/tools/
 *  variables/goal/limits — those are operator decisions the wizard makes
 *  after the draft, never something the model gets to set. */
export interface OfficeDraft {
  name: string;
  description?: string;
  kind?: FlowKind;
  cron?: { agent: string; every: string | number; goal?: string };
  agents: OfficeDraftAgent[];
}

export const MAX_DRAFT_DESCRIPTION = 2000;
export const MAX_DRAFT_AGENTS = 5;

export class DraftError extends Error {
  constructor(readonly kind: "input" | "draft", message: string, readonly detail: string) {
    super(message);
    this.name = "DraftError";
  }
}

export function draftSystemPrompt(language: KernelLanguage): string {
  const human = language === "es" ? "Spanish" : "English";
  return [
    'You design a team of AI agents (an "office") for Kernl from the operator\'s description.',
    "Reply with ONE JSON object and nothing else, shaped like:",
    `{"name": string (max 40 chars), "description": string, "kind": one of ${JSON.stringify(FLOW_KINDS)},`,
    ' "agents": [{"name": string (max 32 chars), "role": "manager" | "worker", "description": string (one line),',
    '   "prompt": string, "chainTo": [names of the workers it hands work to] (manager only)}],',
    ' "cron": {"agent": the manager name, "every": "15m" | "1h" | "1d"} (omit when the team should only run on demand)}',
    "Rules:",
    `- 1 to ${MAX_DRAFT_AGENTS} agents. Exactly one manager when there are two or more agents.`,
    "- Each prompt tells the agent what it does on every run, in second person, in at most 6 sentences.",
    '- Use "devops" only for teams that work on code or infrastructure, "communications" for mail and messaging, "creative" for visual or media work, "general" otherwise.',
    `- Write name, description and the agents' descriptions in ${human}. Write prompts in English.`,
  ].join("\n");
}

export async function draftOfficeDefinition(
  input: { description: string; language: KernelLanguage },
  chatJson: ChatJson,
): Promise<OfficeDraft> {
  const description = input.description.trim();
  if (!description) throw new DraftError("input", "description is required", "");
  if (description.length > MAX_DRAFT_DESCRIPTION) {
    throw new DraftError("input", `description is longer than ${MAX_DRAFT_DESCRIPTION} characters`, "");
  }

  // One ask, then one repair. A model that misses the shape usually misses it
  // narrowly — a field named wrong, a manager missing from a two-agent team —
  // and telling it exactly what failed fixes that far more often than asking
  // the operator to rewrite a description that was never the problem. Two
  // attempts and no more: a model that cannot follow the schema twice will not
  // follow it on the fifth try, and the operator is waiting.
  //
  // officeDefinitionFromJson both validates the model's reply (defineOffice)
  // and accepts its raw output as-is: it already names chain targets and the
  // cron agent by NAME, exactly as the system prompt asks for.
  let def: OfficeDefinition | null = null;
  let lastDetail = "";
  for (let attempt = 0; attempt < 2 && !def; attempt++) {
    const user = attempt === 0
      ? description
      : [
          description,
          "",
          `Your previous reply was rejected: ${lastDetail}`,
          "Reply again with ONE JSON object that fixes exactly that. No prose, no code fence.",
        ].join("\n");
    try {
      const raw = await chatJson({
        system: draftSystemPrompt(input.language),
        user,
        json: true,
        maxTokens: 2048,
        caller: attempt === 0 ? "offices:draft" : "offices:draft:repair",
      });
      def = officeDefinitionFromJson(raw);
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
    }
  }
  if (!def) throw new DraftError("draft", "invalid_draft", lastDetail);
  if (def.agents.length > MAX_DRAFT_AGENTS) {
    throw new DraftError("draft", "invalid_draft", `the draft has ${def.agents.length} agents; the limit is ${MAX_DRAFT_AGENTS}`);
  }

  // Whitelist the response, and undo the slug resolution officeDefinitionFromJson
  // just did: the wizard sends names back (see OfficeDraft), and POST
  // /api/offices/create re-derives slugs from the FINAL office name — a slug
  // baked in here would go stale if the operator renames the office or an
  // agent before founding it.
  const slugToName = new Map(def.agents.map((a) => [a.slug, a.name] as const));
  const toName = (v: string): string => slugToName.get(v) ?? v;
  return {
    name: def.name,
    description: def.description,
    kind: def.kind,
    agents: def.agents.map((a) => ({
      name: a.name,
      role: a.role,
      description: a.description,
      prompt: a.prompt,
      chainTo: a.chainTo?.map(toName),
    })),
    cron: def.cron ? { agent: toName(def.cron.agent), every: def.cron.every, goal: def.cron.goal } : undefined,
  };
}

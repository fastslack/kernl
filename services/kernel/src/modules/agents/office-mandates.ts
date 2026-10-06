/**
 * Full mandates for the agents an operator founds without writing a prompt.
 *
 * The wizard falls back to "You are <name>. <what it does>" — one line the
 * agent then runs on forever. Before the office is materialized, offices.create
 * asks the model ONCE for the whole team: each agent gets a real mandate built
 * from its title and description, its role, the office's purpose and who it
 * works with. Best effort: any failure leaves the one-liners in place, so
 * founding an office never fails because the model did.
 *
 * The model call is injected (`chatJson`) so this runs in tests without a
 * bootstrapped kernel; the operation passes `llm().chatJson`.
 */
import type { KernelLanguage } from "../../core/config.js";
import type { ChatJson } from "./office-draft.js";
import type { OfficeDefinition } from "./office-kit.js";

/** A mandate shorter than this is not worth replacing the fallback with. */
const MIN_MANDATE = 200;
const MAX_MANDATE = 6000;

function systemPrompt(language: KernelLanguage): string {
  const human = language === "es" ? "Spanish (Rioplatense, voseo)" : "English";
  return [
    "You write the standing mandate (system prompt) for AI agents that work in an office of a personal operations platform.",
    "Each agent runs on its own, again and again, with only this mandate as its standing instructions — so it must carry real context.",
    "",
    "For every agent you are given, write a mandate in second person that covers, with markdown headings:",
    "- **Role** — who it is and why it exists in this office, inferred from its title and description. Be concrete about the domain.",
    "- **Responsibilities** — 5 to 8 bullets of what it actually does on a run.",
    "- **Team** — who it reports to or hands work to, by name, and what it expects from / gives to each teammate.",
    "- **Deliverables** — what a finished run leaves behind and the format of its final message.",
    "- **Quality bar** — how it judges its own work before saying it is done.",
    "- **Boundaries** — what it must not do (scope creep, inventing results, acting outside the office).",
    "Between 220 and 450 words per agent. No greetings, no filler, no placeholders.",
    `Write the mandates in ${human}.`,
    "",
    'Reply with ONE JSON object: {"mandates":[{"name":"<agent name exactly as given>","mandate":"<markdown>"}]}. No prose, no code fence.',
  ].join("\n");
}

function userPrompt(def: OfficeDefinition, targets: string[]): string {
  const lead = def.agents.find((a) => a.role === "manager");
  const lines = [
    `Office: ${def.name}`,
    def.description ? `Purpose: ${def.description}` : "",
    def.kind ? `Kind: ${def.kind}` : "",
    def.repo ? `Works on the code repository at ${def.repo}.` : "",
    "",
    "Team:",
    ...def.agents.map((a) => {
      const role = a === lead ? "lead (hands work to the team)" : "member";
      const chain = a.chainTo?.length ? ` — hands its result to: ${a.chainTo.map((s) => def.agents.find((x) => x.slug === s)?.name ?? s).join(", ")}` : "";
      return `- ${a.name} (${role})${a.description ? `: ${a.description}` : ""}${chain}`;
    }),
    "",
    `Write mandates for: ${targets.join(", ")}`,
  ];
  return lines.filter((l, i, arr) => l !== "" || arr[i - 1] !== "").join("\n");
}

/**
 * Replace the prompt of every agent named in `names` with a generated mandate.
 * Returns how many were replaced; agents the model skipped keep their prompt.
 */
export async function expandMandates(
  def: OfficeDefinition,
  names: string[],
  language: KernelLanguage,
  chatJson: ChatJson,
): Promise<number> {
  const wanted = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const targets = def.agents.filter((a) => wanted.has(a.name.trim().toLowerCase()));
  if (targets.length === 0) return 0;

  const raw = await chatJson({
    system: systemPrompt(language),
    user: userPrompt(def, targets.map((a) => a.name)),
    json: true,
    maxTokens: Math.min(8000, 900 * targets.length + 400),
    caller: "offices:mandates",
  });
  const list = (raw as { mandates?: unknown })?.mandates;
  if (!Array.isArray(list)) throw new Error("mandates: reply has no mandates array");

  let replaced = 0;
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim().toLowerCase() : "";
    const mandate = typeof o.mandate === "string" ? o.mandate.trim() : "";
    if (!name || mandate.length < MIN_MANDATE) continue;
    const agent = targets.find((a) => a.name.trim().toLowerCase() === name);
    if (!agent) continue;
    agent.prompt = mandate.slice(0, MAX_MANDATE);
    replaced++;
  }
  return replaced;
}

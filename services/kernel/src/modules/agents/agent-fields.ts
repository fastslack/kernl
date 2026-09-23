/**
 * Typed readers for the JSON held in the agents table's TEXT columns
 * (allowed_tools, denied_tools, variables, model_chain, skills_json).
 *
 * Every reader degrades to the column's "nothing set" value — [] or {} —
 * when the text is empty, malformed or the wrong shape, so a bad row never
 * throws out of whatever was reading it. Each takes only the column it
 * reads, so a partial row (`SELECT variables FROM agents …`) works as well
 * as a full Agent.
 */

import { jsonArray, jsonObject, safeJson } from "../../core/helpers.js";
import type { ModelChainEntry } from "./types.js";

/**
 * A tool-name list. Some rows hold it double-encoded (a JSON string whose
 * content is the array, '"[\"a\"]"'), so a string is decoded once more.
 * Elements are passed through as stored, not filtered.
 */
function toolList(raw: string | null | undefined): string[] {
  const value = safeJson<unknown>(raw, []);
  if (Array.isArray(value)) return value as string[];
  return typeof value === "string" ? jsonArray<string>(value) : [];
}

/** allowed_tools: the tools the agent may use; [] means "all tools". */
export function agentAllowedTools(a: { allowed_tools?: string | null }): string[] {
  return toolList(a.allowed_tools);
}

/** denied_tools: the tools taken away from the agent. */
export function agentDeniedTools(a: { denied_tools?: string | null }): string[] {
  return toolList(a.denied_tools);
}

/** variables: the agent's key/value settings ({{var}} interpolation, handler tunables). */
export function agentVariables(a: { variables?: string | null }): Record<string, unknown> {
  return jsonObject(a.variables);
}

/**
 * model_chain: the agent's own (provider, model) fallback list. Entries that
 * are not objects, or have neither a provider nor a model, are dropped; []
 * means "no chain" (the column is "" then — use the agent's provider/model).
 */
export function agentModelChain(a: { model_chain?: string | null }): ModelChainEntry[] {
  const chain: ModelChainEntry[] = [];
  for (const raw of jsonArray(a.model_chain)) {
    if (!raw || typeof raw !== "object") continue;
    const p = String((raw as Record<string, unknown>).provider ?? "");
    const m = String((raw as Record<string, unknown>).model ?? "");
    if (p || m) chain.push({ provider: p, model: m });
  }
  return chain;
}

/** skills_json: the slugs of the procedural skills attached to the agent. */
export function agentSkills(a: { skills_json?: string | null }): string[] {
  return jsonArray<string>(a.skills_json);
}

/**
 * The variables of the agent running built-in handler `handler`. Defined in
 * the SDK (same `jsonObject` read as `agentVariables` above) so extension
 * drivers read their tunables exactly the way kernel handlers do.
 */
export { readHandlerVars } from "../../sdk/agent-vars.js";

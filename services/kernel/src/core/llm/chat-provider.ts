/**
 * The chat adapter contract (`ChatLlmProvider`) and what every adapter shares:
 * the per-request HTTP timeout and the per-provider tool caps.
 */
import { log } from "../logger.js";
import { getCatalogEntry } from "./provider-catalog.js";
import type { ChatMessage, ChatCompletionResult, ChatCompletionOptions } from "./chat-types.js";

// HTTP timeout for a single LLM API call. 5 min is generous — normal responses
// complete in <30s even for complex tool-use turns. This gives headroom for
// occasional API slowness without masking real issues.
export const ADAPTER_TIMEOUT_MS = 300_000;

// ── Interface ────────────────────────────────────────

export interface ChatLlmProvider {
  readonly name: string;
  available(): boolean;
  /**
   * Whether this provider can sustain a tool-use loop — send tool definitions,
   * receive a tool call, take the result back and continue.
   *
   * Absent means yes; every API-backed provider drives its own loop. Only set
   * it to `false` for a provider that structurally cannot, like the
   * claude_code CLI shim, which runs a single turn with no tools. Handing an
   * agent's tools to one of those produces a turn-limit error rather than an
   * honest "unsupported", so callers that need tools filter on this.
   */
  readonly supportsToolLoop?: boolean;
  chatCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult>;
}

// ── Tool truncation (per-provider caps) ──────────────
//
// Each provider has a different ceiling on how many tools it can handle
// reliably. OpenAI's API hard-caps at 128. LM Studio loads quantized
// models with tiny context windows (4-8k) — past ~16 tools the system
// prompt + tool defs already blow the context. Claude/NVIDIA/Grok don't
// publish a number but quality degrades past ~64.
//
// `truncateTools(provider, tools)` is the single source of truth: cap
// per provider + log-once dedup. Each provider call site invokes it
// before sending the request. Order is preserved — callers pass tools
// in priority order so the first N survive.

const TOOL_CAPS: Record<string, number> = {
  openai:   128, // hard API limit
  claude:   128, // soft cap — Anthropic accepts more but quality drops
  grok:     64,
  nvidia:   64,
  lmstudio: 16,  // local quantized models choke past this
  ollama:   16,
  claude_code: 64,
  "claude-code": 64,
};
const DEFAULT_TOOL_CAP = 128;

const _toolTruncationLogged = new Set<string>();
function logToolTruncationOnce(providerName: string, count: number, cap: number): void {
  const key = `${providerName}:${count}:${cap}`;
  if (_toolTruncationLogged.has(key)) return;
  _toolTruncationLogged.add(key);
  log.warn(`${providerName}: ${count} tools exceeds the ${cap}-tool cap — truncating to first ${cap}. Restrict agent.allowed_tools to silence (logged once per process per count).`);
}

/** Truncate to the provider's safe cap, log-once when we have to. */
export function truncateTools<T>(providerName: string, tools: T[]): T[] {
  const cap = getCatalogEntry(providerName)?.toolCap ?? TOOL_CAPS[providerName] ?? DEFAULT_TOOL_CAP;
  if (tools.length <= cap) return tools;
  logToolTruncationOnce(providerName, tools.length, cap);
  return tools.slice(0, cap);
}

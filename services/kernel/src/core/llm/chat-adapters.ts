import { log } from "../logger.js";
import { detectLmStudio } from "./lmstudio-detect.js";
import type { SqliteDb } from "../db/sqlite.js";
import { runMigrations, type Migration } from "../db/migrations.js";
import * as providerHealth from "./provider-health.js";
import { logLlmStart, logLlmEnd, logLlmFail } from "./logger.js";
import { ChatClaudeCodeProvider } from "./claude-code-adapter.js";
import type {
  ChatMessage,
  ChatCompletionResult,
  ChatCompletionOptions,
  ToolUseBlock,
  ImageBlock,
} from "./chat-types.js";

import type { ContentBlock } from "./chat-types.js";
import { PROVIDER_CATALOG, getCatalogEntry, fallbackOrder, quirksFor } from "./provider-catalog.js";
import { getProviderConfig, isConnected, type ProviderConfig } from "./credentials.js";
import { stripReasoning } from "./strip-reasoning.js";
import type { ClaudeCodeProviderOptions } from "./claude-code-adapter.js";

// HTTP timeout for a single LLM API call. 5 min is generous — normal responses
// complete in <30s even for complex tool-use turns. This gives headroom for
// occasional API slowness without masking real issues.
const TIMEOUT_MS = 300_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a fetch call on 429 with exponential backoff.
 * Respects retry-after header when present.
 */
async function retryWithBackoff(
  fn: () => Promise<Response>,
  onRateLimitWait?: (waitMs: number, attempt: number) => void,
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fn();
    if (resp.status !== 429) return resp;

    if (attempt === MAX_RETRIES) return resp;

    const retryAfterHeader = resp.headers.get("retry-after");
    let waitMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1); // 2s, 4s, 8s
    if (retryAfterHeader) {
      const parsed = Number(retryAfterHeader);
      if (!Number.isNaN(parsed)) {
        waitMs = parsed * 1000;
      }
    }

    log.warn(`Rate limit hit (429), retrying in ${waitMs / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
    onRateLimitWait?.(waitMs, attempt);

    // Consume the body to free the connection
    await resp.text().catch(() => "");

    await sleep(waitMs);
  }

  // Unreachable, but TypeScript needs it
  return fn();
}

/** Extract text from ChatMessage content (string or ContentBlock[]) */
function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Check if content has image blocks */
function hasImages(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return false;
  return content.some((b) => b.type === "image");
}

/** Convert content to OpenAI vision format */
function toOpenAiContent(content: string | ContentBlock[]): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  if (!hasImages(content)) return textOf(content);
  const parts: Array<Record<string, unknown>> = [];
  for (const b of content) {
    if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      const img = b as ImageBlock;
      parts.push({
        type: "image_url",
        image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` },
      });
    }
  }
  return parts;
}

/**
 * Translate kernel ChatMessages (Anthropic-shaped content blocks) into the
 * OpenAI chat/completions format. A single kernel message with mixed content
 * blocks may expand into multiple OpenAI messages — specifically:
 *   - An assistant message carrying `tool_use` blocks becomes an OpenAI
 *     assistant message with `tool_calls: [...]` (content = text only).
 *   - A user message carrying `tool_result` blocks becomes one OpenAI message
 *     per result with `role: "tool"` and `tool_call_id`.
 */
function kernelMessagesToOpenAi(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    const textBlocks: Array<{ type: "text"; text: string }> = [];
    const toolUses: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];
    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> = [];
    const images: Array<{ type: "image"; source: { media_type: string; data: string } }> = [];

    for (const b of m.content) {
      if (b.type === "text") textBlocks.push(b as { type: "text"; text: string });
      else if (b.type === "tool_use") toolUses.push(b as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> });
      else if (b.type === "tool_result") {
        const tr = b as { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean };
        const contentStr = typeof tr.content === "string" ? tr.content : textOf(tr.content);
        toolResults.push({ type: "tool_result", tool_use_id: tr.tool_use_id, content: contentStr, is_error: tr.is_error });
      } else if (b.type === "image") images.push(b as { type: "image"; source: { media_type: string; data: string } });
    }

    if (m.role === "assistant") {
      // Assistant turn: optional text + optional tool_calls
      const msg: Record<string, unknown> = { role: "assistant" };
      msg.content = textBlocks.map((t) => t.text).join("") || null;
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
        }));
      }
      out.push(msg);
      continue;
    }

    // user role
    if (toolResults.length > 0) {
      // Each tool_result becomes its own tool-role message
      for (const tr of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: tr.is_error ? `ERROR: ${tr.content}` : tr.content,
        });
      }
    }
    if (textBlocks.length > 0 || images.length > 0) {
      // Any plain text / image content in a user turn
      const blocks: Array<Record<string, unknown>> = [];
      for (const t of textBlocks) blocks.push({ type: "text", text: t.text });
      for (const img of images) {
        blocks.push({
          type: "image_url",
          image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` },
        });
      }
      out.push({
        role: "user",
        content: images.length > 0 ? blocks : textBlocks.map((t) => t.text).join(""),
      });
    }
  }
  return out;
}

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

// ── Claude ───────────────────────────────────────────

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_DEFAULT_MODEL = "claude-sonnet-4-20250514";

export class ChatClaudeProvider implements ChatLlmProvider {
  readonly name = "claude";

  constructor(
    private apiKey: string,
    private defaultModel: string = CLAUDE_DEFAULT_MODEL,
  ) {}

  available(): boolean {
    return this.apiKey.length > 0;
  }

  async chatCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    const model = opts?.model || this.defaultModel;

    // Claude API separates system from messages
    const systemMessages = messages.filter((m) => m.role === "system");
    const chatMessages = messages.filter((m) => m.role !== "system");
    const system =
      opts?.system ||
      systemMessages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .filter(Boolean)
        .join("\n\n") ||
      undefined;

    const body: Record<string, unknown> = {
      model,
      max_tokens: opts?.max_tokens ?? 4096,
      ...(system && { system }),
      messages: chatMessages.map((m) => ({
        role: m.role,
        content: m.content, // string or ContentBlock[]
      })),
      ...(opts?.temperature !== undefined && {
        temperature: opts.temperature,
      }),
    };

    // Add tools if provided. Force sequential tool use — parallel tool_use
    // has been observed to make agents repeat identical batch calls instead
    // of processing results between turns. Truncate to Claude's safe cap
    // so a misconfigured `allowed_tools: []` agent doesn't bloat the system
    // prompt past the context window.
    if (opts?.tools && opts.tools.length > 0) {
      body.tools = truncateTools("claude", opts.tools);
      body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }


    const resp = await retryWithBackoff(
      () => fetch(CLAUDE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      opts?.onRateLimitWait,
    );

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      if (resp.status === 429 || resp.status === 402 || errBody.includes("credit balance") || errBody.includes("billing")) {
        markProviderExhausted("claude");
      }
      throw new Error(`Claude API error ${resp.status}: ${errBody}`);
    }

    const data = (await resp.json()) as {
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      model: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };

    // Extract text content
    const content = data.content
      ?.filter((c) => c.type === "text")
      ?.map((c) => c.text ?? "")
      .join("") ?? "";

    // Extract tool_use blocks
    const toolCalls: ToolUseBlock[] = data.content
      ?.filter((c) => c.type === "tool_use")
      ?.map((c) => ({
        type: "tool_use" as const,
        id: c.id!,
        name: c.name!,
        input: c.input ?? {},
      })) ?? [];

    const tokens =
      (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

    return {
      content,
      model: data.model ?? model,
      tokens_used: tokens,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      stop_reason: data.stop_reason,
    };
  }
}

// ── OpenAI ───────────────────────────────────────────

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

export class ChatOpenAiProvider implements ChatLlmProvider {
  readonly name: string;

  constructor(
    protected apiKey: string,
    protected baseUrl: string = OPENAI_DEFAULT_BASE,
    protected defaultModel: string = OPENAI_DEFAULT_MODEL,
    name: string = "openai",
  ) {
    this.name = name;
  }

  available(): boolean {
    return this.apiKey.length > 0;
  }

  async chatCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    const model = opts?.model || this.defaultModel;
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const apiMessages: Array<Record<string, unknown>> = [];
    if (opts?.system) {
      apiMessages.push({ role: "system", content: opts.system });
    }
    apiMessages.push(...kernelMessagesToOpenAi(messages));

    const body: Record<string, unknown> = {
      model,
      max_tokens: opts?.max_tokens ?? 4096,
      messages: apiMessages,
    };
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    // Per-model request tweaks the provider documents (sampling, template
    // flags). The caller's own temperature still wins.
    const quirks = quirksFor(this.name, model);
    if (quirks) {
      if (body.temperature === undefined && quirks.temperature !== undefined) body.temperature = quirks.temperature;
      if (quirks.topP !== undefined) body.top_p = quirks.topP;
      if (quirks.extraBody) Object.assign(body, quirks.extraBody);
    }
    // Pass tools in OpenAI format if provided (sequential tool calls only).
    // truncateTools applies the right cap per slug — openai 128, grok 64,
    // nvidia 64 (Grok/NVIDIA inherit ChatOpenAiProvider but pass their
    // own `this.name` so the right cap kicks in).
    if (opts?.tools && opts.tools.length > 0) {
      const tools = truncateTools(this.name, opts.tools);
      body.tools = tools.map(t => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
      body.parallel_tool_calls = false;
    }

    const resp = await retryWithBackoff(
      () => fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      opts?.onRateLimitWait,
    );

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      // Detect quota exhaustion → mark provider so resolveProvider falls back
      if (resp.status === 429 || resp.status === 402 || errBody.includes("insufficient_quota") || errBody.includes("exceeded your current quota")) {
        markProviderExhausted(this.name);
      }
      throw new Error(`${this.name} API error ${resp.status}: ${errBody}`);
    }

    const data = (await resp.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
      model?: string;
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    };

    const msg = data.choices?.[0]?.message;
    // Reasoning models on these endpoints (Nemotron, DeepSeek, Kimi, MiniMax)
    // can prepend a <think> block; it is scratchpad, never the answer.
    const content = stripReasoning(msg?.content ?? "");
    const tokens = data.usage?.total_tokens ?? 0;

    // Parse OpenAI-format tool_calls
    const toolCalls: ToolUseBlock[] = [];
    if (msg?.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        try {
          toolCalls.push({
            type: "tool_use",
            id: tc.id || `oai-${Date.now()}`,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || "{}"),
          });
        } catch { /* skip malformed */ }
      }
    }

    return {
      content,
      model: data.model ?? model,
      tokens_used: tokens,
      input_tokens: data.usage?.prompt_tokens,
      output_tokens: data.usage?.completion_tokens,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
}

// ── LMStudio (OpenAI Responses API) ──────────────────
// LM Studio exposes the OpenAI Responses API at /v1/responses. Compared with
// /v1/chat/completions: tools are flat (no `function: {...}` wrapper), system
// prompt goes in `instructions`, conversation history is an array of "items"
// passed via `input`, and the answer arrives as `output[]` with item types
// `message` (text), `function_call` (tool_use), and `reasoning` (ignored).
// Multi-turn tool flows pass back `function_call_output` items keyed by `call_id`.

const LMSTUDIO_DEFAULT_BASE = "http://localhost:1234/v1";

/**
 * Translate kernel ChatMessages (Anthropic-shaped) into OpenAI Responses API
 * `input` items + `instructions`. System turns collapse into `instructions`
 * (Responses API doesn't accept role="system" inside input). Assistant tool_use
 * blocks become `function_call` items; user tool_result blocks become
 * `function_call_output` items keyed by `call_id`.
 */
function kernelMessagesToResponsesInput(
  messages: ChatMessage[],
): { instructions?: string; input: Array<Record<string, unknown>> } {
  const instructionParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : textOf(m.content);
      if (text) instructionParts.push(text);
      continue;
    }

    if (typeof m.content === "string") {
      input.push({
        type: "message",
        role: m.role,
        content: [
          {
            type: m.role === "assistant" ? "output_text" : "input_text",
            text: m.content,
          },
        ],
      });
      continue;
    }

    const textBlocks: Array<{ type: "text"; text: string }> = [];
    const toolUses: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];
    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }> = [];
    const images: Array<ImageBlock> = [];

    for (const b of m.content) {
      if (b.type === "text") textBlocks.push(b as { type: "text"; text: string });
      else if (b.type === "tool_use") toolUses.push(b as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> });
      else if (b.type === "tool_result") toolResults.push(b as { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean });
      else if (b.type === "image") images.push(b as ImageBlock);
    }

    if (m.role === "assistant") {
      const text = textBlocks.map((t) => t.text).join("");
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const tu of toolUses) {
        input.push({
          type: "function_call",
          call_id: tu.id,
          name: tu.name,
          arguments: JSON.stringify(tu.input ?? {}),
        });
      }
      continue;
    }

    // user role
    for (const tr of toolResults) {
      const out = typeof tr.content === "string" ? tr.content : textOf(tr.content);
      input.push({
        type: "function_call_output",
        call_id: tr.tool_use_id,
        output: tr.is_error ? `ERROR: ${out}` : out,
      });
    }
    if (textBlocks.length > 0 || images.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      for (const t of textBlocks) content.push({ type: "input_text", text: t.text });
      for (const img of images) {
        content.push({
          type: "input_image",
          image_url: `data:${img.source.media_type};base64,${img.source.data}`,
        });
      }
      input.push({ type: "message", role: "user", content });
    }
  }

  return {
    instructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
    input,
  };
}

export class ChatLmStudioProvider implements ChatLlmProvider {
  readonly name = "lmstudio";
  /** Serial queue — LM Studio processes one request at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private baseUrl: string = LMSTUDIO_DEFAULT_BASE,
    private defaultModel: string = "",
  ) {}

  available(): boolean {
    return this.baseUrl.length > 0;
  }

  /** Cached across calls — LM Studio will not swap model mid-sentence. */
  private resolved?: string;

  private async resolveLoadedModel(): Promise<string> {
    if (this.resolved !== undefined) return this.resolved;
    const found = await detectLmStudio(this.baseUrl);
    this.resolved = found.activeModel ?? "";
    if (this.resolved) log.info(`LM Studio: no model given, using loaded "${this.resolved}"`);
    return this.resolved;
  }

  async chatCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    // Queue requests serially — LM Studio can only handle one at a time.
    // Without this, concurrent requests get timeouts or corrupted responses.
    return new Promise<ChatCompletionResult>((resolve, reject) => {
      this.queue = this.queue
        .then(() => this._doCompletion(messages, opts))
        .then(resolve)
        .catch(reject);
    });
  }

  private async _doCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    // No hardcoded fallback. This used to end in "zai-org/glm-4.7-flash" — a
    // model that exists on nobody's machine but the one it was typed on. LM
    // Studio serves only what is downloaded, so the phantom id came back as
    //   Invalid model identifier "zai-org/glm-4.7-flash" (model_not_found)
    // for every user, with nothing in Kernl's own config to explain where the
    // name had come from. The provider now resolves the loaded model at start
    // and passes it in as defaultModel; if that failed too, say so plainly
    // rather than inventing a name.
    // Resolve the model here when the caller named none. Two places build this
    // adapter — the provider registry, which knows the model, and the chat
    // provider map, which does not — so relying on the caller left the second
    // one empty. It used to fall back to a hardcoded "zai-org/glm-4.7-flash",
    // a model that exists on nobody's machine, and LM Studio answered
    // `model_not_found` for every message sent through that path.
    const model = opts?.model || this.defaultModel || (await this.resolveLoadedModel());
    if (!model) {
      throw new Error(
        `No model is loaded in LM Studio at ${this.baseUrl} — load one in the app, or pick a model in the selector.`,
      );
    }
    const url = `${this.baseUrl.replace(/\/+$/, "")}/responses`;

    // Truncate aggressively to keep the locally-hosted model context manageable.
    const MAX_INPUT_CHARS = 24_000;
    const { instructions: convertedInstr, input: convertedInput } = kernelMessagesToResponsesInput(messages);

    let instructions: string | undefined;
    let totalChars = 0;
    const sys = opts?.system ?? convertedInstr;
    if (sys) {
      const maxSys = Math.min(sys.length, Math.floor(MAX_INPUT_CHARS * 0.6));
      instructions = sys.length > maxSys ? sys.slice(0, maxSys) + "\n[system prompt truncated]" : sys;
      totalChars += instructions.length;
    }

    const apiInput: Array<Record<string, unknown>> = [];
    for (const item of convertedInput) {
      const remaining = MAX_INPUT_CHARS - totalChars;
      if (remaining <= 100) break;
      const itemSize = approxItemChars(item);
      if (itemSize > remaining) {
        const truncated = truncateInputItem(item, remaining);
        apiInput.push(truncated);
        break;
      }
      apiInput.push(item);
      totalChars += itemSize;
    }

    const body: Record<string, unknown> = {
      model,
      input: apiInput,
      max_output_tokens: opts?.max_tokens ?? 4096,
    };
    if (instructions) body.instructions = instructions;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    // Responses API tool format: flat {type,name,description,parameters} —
    // no `function: {...}` wrapper. truncateTools applies LM Studio's cap
    // (currently 16) so small-context quantized models don't blow up.
    if (opts?.tools && opts.tools.length > 0) {
      const tools = truncateTools(this.name, opts.tools);
      body.tools = tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? { type: "object", properties: {} },
      }));
      body.parallel_tool_calls = false;
      if (!body.tool_choice) body.tool_choice = "auto";
    }

    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await retryWithBackoff(
        () => fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
        opts?.onRateLimitWait,
      );

      if (resp.ok) {
        const data = await resp.json();
        return this._parseResponse(data, model);
      }

      const errBody = await resp.text().catch(() => "");
      lastError = `LMStudio API error ${resp.status}: ${errBody}`;

      if (resp.status === 400 && errBody.includes("n_keep")) {
        log.warn(`LMStudio context overflow (attempt ${attempt + 1}), halving input`);
        const items = body.input as Array<Record<string, unknown>>;
        for (const it of items) shrinkInputItem(it, 1500);
        body.input = items;
        body.tools = undefined;
        continue;
      }

      throw new Error(lastError);
    }
    throw new Error(lastError);
  }

  private _parseResponse(data: unknown, model: string): ChatCompletionResult {
    const d = data as {
      output?: Array<{
        type: string;
        role?: string;
        content?: Array<{ type: string; text?: string }>;
        call_id?: string;
        id?: string;
        name?: string;
        arguments?: string;
      }>;
      model?: string;
      status?: string;
      usage?: { total_tokens?: number };
    };

    let content = "";
    const toolCalls: ToolUseBlock[] = [];

    for (const item of d.output ?? []) {
      if (item.type === "message") {
        for (const c of item.content ?? []) {
          if (c.type === "output_text" && typeof c.text === "string") content += c.text;
        }
      } else if (item.type === "function_call") {
        try {
          toolCalls.push({
            type: "tool_use",
            id: item.call_id || item.id || `lms-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: item.name ?? "",
            input: JSON.parse(item.arguments || "{}"),
          });
        } catch { /* skip malformed tool call */ }
      }
      // `reasoning` items are ignored — they're chain-of-thought scratchpad
    }

    return {
      content,
      model: d.model ?? model ?? "lmstudio",
      tokens_used: d.usage?.total_tokens ?? 0,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      stop_reason: d.status,
    };
  }
}

/** Approximate the character length of a Responses API input item. */
function approxItemChars(item: Record<string, unknown>): number {
  if (item.type === "message") {
    const parts = (item.content as Array<{ text?: string; image_url?: string }> | undefined) ?? [];
    return parts.reduce((sum, p) => sum + (p.text?.length ?? 0) + (p.image_url?.length ?? 0), 0);
  }
  if (item.type === "function_call") {
    return String(item.name ?? "").length + String(item.arguments ?? "").length;
  }
  if (item.type === "function_call_output") {
    return String(item.output ?? "").length;
  }
  return JSON.stringify(item).length;
}

/** Truncate the textual portion of a single input item to fit `maxChars`. */
function truncateInputItem(item: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  if (item.type === "message") {
    const parts = (item.content as Array<{ type: string; text?: string; image_url?: string }> | undefined) ?? [];
    let remaining = maxChars;
    const out: Array<Record<string, unknown>> = [];
    for (const p of parts) {
      if (p.text != null) {
        const text = p.text.length > remaining ? p.text.slice(0, remaining) + "\n[truncated]" : p.text;
        out.push({ ...p, text });
        remaining -= text.length;
        if (remaining <= 0) break;
      } else {
        out.push(p);
      }
    }
    return { ...item, content: out };
  }
  if (item.type === "function_call_output") {
    const s = String(item.output ?? "");
    return { ...item, output: s.length > maxChars ? s.slice(0, maxChars) + "[truncated]" : s };
  }
  return item;
}

/** Mutate-in-place version used by the context-overflow retry path. */
function shrinkInputItem(item: Record<string, unknown>, maxChars: number): void {
  if (item.type === "message" && Array.isArray(item.content)) {
    for (const p of item.content as Array<{ text?: string }>) {
      if (typeof p.text === "string" && p.text.length > maxChars) {
        p.text = p.text.slice(0, maxChars);
      }
    }
  } else if (item.type === "function_call_output") {
    const s = String(item.output ?? "");
    if (s.length > maxChars) item.output = s.slice(0, maxChars);
  }
}

// ── Registry ─────────────────────────────────────────

/**
 * Wrap a provider's `chatCompletion` to report latency + classify failures
 * into the shared health tracker. Mutates the instance once; safe to call
 * for instances stored under multiple Map keys (only wraps the function ref,
 * which we replace exactly once via the `__instrumented` marker).
 */
function instrumentProvider<P extends ChatLlmProvider>(p: P): P {
  const marker = p as unknown as { __healthInstrumented?: boolean };
  if (marker.__healthInstrumented) return p;
  marker.__healthInstrumented = true;

  const original = p.chatCompletion.bind(p);
  p.chatCompletion = async (msgs, opts) => {
    const t0 = Date.now();
    const requestedModel = opts?.model;
    const caller = opts?.caller;
    // Pull a short preview of the last user message for verbose mode.
    let preview: string | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "user") continue;
      preview = typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join(" ");
      break;
    }
    logLlmStart({
      slug: p.name,
      model: requestedModel,
      messageCount: msgs.length,
      toolCount: opts?.tools?.length ?? 0,
      caller,
      preview,
    });

    try {
      const result = await original(msgs, opts);
      const durationMs = Date.now() - t0;
      providerHealth.recordSuccess(p.name, durationMs);
      logLlmEnd({
        slug: p.name,
        model: result.model || requestedModel,
        durationMs,
        tokens: result.tokens_used,
        toolCalls: result.tool_calls?.length ?? 0,
        caller,
        preview: result.content,
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - t0;
      const kind = providerHealth.classifyError(err);
      const message = err instanceof Error ? err.message : String(err);
      providerHealth.recordFailure(p.name, kind);
      // A model the provider advertises but does not serve retires itself
      // here, so the picker stops handing it to the next person.
      providerHealth.reportModelFault(p.name, requestedModel ?? "", kind, message);
      logLlmFail({
        slug: p.name,
        model: requestedModel,
        durationMs,
        kind,
        message,
        caller,
      });
      throw err;
    }
  };
  return p;
}

export interface AdapterOptions {
  /** Kernel-wide chat default, used where the provider has no model of its own. */
  defaultModel?: string;
  /** Claude Code subprocess/MCP wiring (from `config.claudeCode`). */
  claudeCode?: ClaudeCodeProviderOptions;
}

/**
 * One chat adapter for one catalog provider, built from its stored config.
 *
 * `override` lets the connect dialog test a key the user just pasted without
 * saving it first: non-empty strings replace the stored values, nothing is
 * written anywhere.
 */
export function buildChatAdapter(
  slugOrAlias: string,
  override: Partial<ProviderConfig> = {},
  opts: AdapterOptions = {},
): ChatLlmProvider | null {
  const entry = getCatalogEntry(slugOrAlias);
  if (!entry) return null;
  const cfg: ProviderConfig = { ...getProviderConfig(entry.slug) };
  for (const key of ["apiKey", "baseUrl", "model", "region", "oauthToken"] as const) {
    const v = override[key];
    if (typeof v === "string" && v.trim() !== "") cfg[key] = v.trim();
  }
  if (override.region && !override.baseUrl) {
    const regionBase = entry.regions?.find((r) => r.id === override.region)?.baseUrl;
    if (regionBase) cfg.baseUrl = regionBase;
  }

  switch (entry.kind) {
    case "anthropic":
      return new ChatClaudeProvider(cfg.apiKey, cfg.model || opts.defaultModel || CLAUDE_DEFAULT_MODEL);
    case "claude-code":
      return new ChatClaudeCodeProvider(opts.defaultModel, {
        ...opts.claudeCode,
        model: cfg.model,
        ...(cfg.oauthToken ? { oauthToken: cfg.oauthToken } : {}),
      });
    case "lmstudio":
      return new ChatLmStudioProvider(cfg.baseUrl, cfg.model);
    default:
      // Local OpenAI-compatible servers ignore auth but the header must not be empty.
      return new ChatOpenAiProvider(entry.needsKey ? cfg.apiKey : (cfg.apiKey || "local"), cfg.baseUrl, cfg.model, entry.slug);
  }
}

export function createChatProviders(options: AdapterOptions = {}): Map<string, ChatLlmProvider> {
  const providers = new Map<string, ChatLlmProvider>();
  for (const entry of PROVIDER_CATALOG) {
    // A local server needs no key, so an unconnected one would still report
    // available() and get picked as a fallback that can only time out.
    if (entry.group === "local" && !isConnected(entry.slug)) continue;
    const adapter = buildChatAdapter(entry.slug, {}, options);
    if (!adapter) continue;
    // One instance under the slug and every alias: stored agent rows use
    // "claude_code", the registry and dashboard use "claude-code".
    const instance = instrumentProvider(adapter);
    providers.set(entry.slug, instance);
    for (const alias of entry.aliases) providers.set(alias, instance);
  }
  return providers;
}

/** Providers that have hit their quota (429/402). Persisted to DB + in-memory cache. */
const _quotaExhausted = new Set<string>();
let _dbRef: SqliteDb | null = null;

/**
 * Schema for the `provider_status` quota-tracking table. Run via the shared
 * migration runner under module "llm" (previously a raw `CREATE TABLE IF NOT
 * EXISTS` exec inside initProviderStatus). `IF NOT EXISTS` is kept so
 * pre-existing databases created by the old raw exec migrate cleanly.
 */
export const providerStatusMigrations: Migration[] = [
  {
    version: 1,
    sql: `CREATE TABLE IF NOT EXISTS provider_status (
    name TEXT PRIMARY KEY,
    exhausted INTEGER NOT NULL DEFAULT 0,
    exhausted_at TEXT,
    daily_budget_tokens INTEGER NOT NULL DEFAULT 0,
    tokens_used_today INTEGER NOT NULL DEFAULT 0,
    budget_date TEXT NOT NULL DEFAULT ''
  )`,
  },
];

/** Connect the quota tracker to the SQLite database for persistence across requests. */
export function initProviderStatus(db: SqliteDb): void {
  _dbRef = db;
  // Create table if missing
  runMigrations(db, "llm", providerStatusMigrations);
  // Load persisted state — only consider exhausted if same day (auto-reset daily)
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare("SELECT name, exhausted, budget_date FROM provider_status").all() as Array<{ name: string; exhausted: number; budget_date: string }>;
  for (const r of rows) {
    if (r.exhausted && r.budget_date === today) {
      _quotaExhausted.add(r.name);
      log.warn(`Provider "${r.name}" still exhausted from earlier today`);
    } else if (r.exhausted && r.budget_date !== today) {
      // New day → clear exhaustion
      db.prepare("UPDATE provider_status SET exhausted = 0, tokens_used_today = 0, budget_date = ? WHERE name = ?").run(today, r.name);
      log.info(`Provider "${r.name}" quota reset (new day)`);
    }
  }
}

/** Mark a provider as out of quota (called on 429/402 errors). */
export function markProviderExhausted(providerName: string): void {
  // Idempotent — every failed call funnels through 2–3 catch blocks (provider
  // 429 handler, chain-runner, instrumentProvider). We only persist + log on
  // the first one. Health tracking (recordFailure) is intentionally NOT done
  // here: instrumentProvider's catch already records the failure once with
  // kind="exhausted", and adding another call here would double-count and
  // double-log "exhausted (failure #N)".
  if (_quotaExhausted.has(providerName)) return;
  _quotaExhausted.add(providerName);
  log.warn(`Provider "${providerName}" marked as quota-exhausted — falling back to alternatives`);
  if (_dbRef) {
    const today = new Date().toISOString().slice(0, 10);
    _dbRef.prepare(
      "INSERT INTO provider_status (name, exhausted, exhausted_at, budget_date) VALUES (?, 1, datetime('now'), ?) ON CONFLICT(name) DO UPDATE SET exhausted = 1, exhausted_at = datetime('now'), budget_date = ?"
    ).run(providerName, today, today);
  }
}

/** Check if a provider has been marked as quota-exhausted. */
export function isProviderExhausted(providerName: string): boolean {
  return _quotaExhausted.has(providerName);
}

/**
 * Clear an exhausted flag manually — used by the operator endpoint when a
 * paid quota is reset out-of-band (e.g. billing top-up) before the daily
 * auto-reset kicks in. Pass an empty/undefined name to clear ALL providers.
 */
export function clearProviderExhausted(providerName?: string): number {
  let cleared = 0;
  const today = new Date().toISOString().slice(0, 10);
  if (!providerName) {
    cleared = _quotaExhausted.size;
    _quotaExhausted.clear();
    if (_dbRef) {
      _dbRef.prepare(
        "UPDATE provider_status SET exhausted = 0, tokens_used_today = 0, budget_date = ? WHERE exhausted = 1",
      ).run(today);
    }
    // Also clear the in-memory LlmHealth backoff window — otherwise an
    // operator who just topped up their account would still have to wait
    // for MAX_EXHAUSTED_BACKOFF_MS (1 h default) before the provider goes
    // back into rotation.
    providerHealth.clearBlock();
    if (cleared > 0) log.info(`Provider exhaustion cleared for all (${cleared} provider(s))`);
    return cleared;
  }
  if (_quotaExhausted.delete(providerName)) cleared = 1;
  if (_dbRef) {
    _dbRef.prepare(
      "UPDATE provider_status SET exhausted = 0, tokens_used_today = 0, budget_date = ? WHERE name = ?",
    ).run(today, providerName);
  }
  providerHealth.clearBlock(providerName);
  if (cleared > 0) log.info(`Provider "${providerName}" exhaustion cleared`);
  return cleared;
}

/**
 * Pick the best available chat provider for a request.
 *
 * Selection rules:
 *   1. The requested slug wins if it's available, not quota-exhausted, and
 *      not currently inside a backoff window — even if its score is worse.
 *      (Caller's explicit choice takes precedence over health ranking.)
 *   2. Otherwise, candidates from FALLBACK_ORDER are filtered by
 *      `available() && !quotaExhausted && !inBackoff`, then sorted by
 *      health score (EWMA latency + failure penalty, lower wins).
 *   3. Defensive sweep: any registered provider not in FALLBACK_ORDER that
 *      passes the same filters.
 *   4. Last resort: any provider whose only problem is being marked
 *      exhausted/in-backoff (better than returning null and crashing).
 *
 * LM Studio is intentionally last in FALLBACK_ORDER — it requires the
 * desktop app to be running and reachable from the kernel's namespace.
 */
/**
 * Resolve a provider together with the model it is allowed to be asked for.
 *
 * A model name belongs to exactly one provider, so it must never travel with a
 * substitution. It did: with NVIDIA in a backoff window, the chat resolved to
 * MiniMax and still sent NVIDIA's model, and MiniMax answered "invalid params,
 * unknown model" — which the UI then showed as NVIDIA's reply. When the
 * provider that comes back is not the one asked for, the model is dropped and
 * the substitute answers with its own default.
 */
export function resolveProviderFor(
  providers: Map<string, ChatLlmProvider>,
  requested: string,
  model: string,
): { provider: ChatLlmProvider; model: string; substituted: boolean } | null {
  const provider = resolveProvider(providers, requested);
  if (!provider) return null;
  const substituted = providers.get(requested) !== provider;
  return { provider, model: substituted ? "" : model, substituted };
}

export function resolveProvider(
  providers: Map<string, ChatLlmProvider>,
  requested: string,
): ChatLlmProvider | null {
  // The catalog's fallback order: recommended, free, paid, local, then the
  // subscription CLI. claude-code is a single-turn shim that ignores tools; a
  // caller that sends tools filters it out through `supportsToolLoop: false`.
  const FALLBACK_ORDER = fallbackOrder();

  // 1. Honour the explicit request when it's truly usable
  const requestedProv = providers.get(requested);
  const requestedHealthy =
    !!requestedProv?.available() &&
    !_quotaExhausted.has(requested) &&
    !providerHealth.isBlocked(requested);
  if (requestedHealthy) return requestedProv!;

  // Reason the requested one was rejected (used for log clarity)
  const rejectReason = !requestedProv?.available()
    ? "unavailable"
    : _quotaExhausted.has(requested)
    ? "quota exhausted"
    : providerHealth.isBlocked(requested)
    ? "in backoff window"
    : "unknown";

  // 2. Score-based selection across the canonical fallback list
  const tried = new Set<string>([requested]);
  const fallbackCandidates = FALLBACK_ORDER.filter(name => {
    if (tried.has(name)) return false;
    const p = providers.get(name);
    if (!p?.available()) return false;
    if (_quotaExhausted.has(name)) return false;
    if (providerHealth.isBlocked(name)) return false;
    return true;
  });
  const ranked = providerHealth.rankCandidates(fallbackCandidates, { primary: requested });
  for (const name of ranked) {
    tried.add(name);
    const p = providers.get(name);
    if (p) {
      log.warn(`Chat: provider "${requested}" ${rejectReason}, falling back to "${name}"`);
      return p;
    }
  }

  // 3. Any leftover provider not in FALLBACK_ORDER (defensive — covers
  //    extension-registered providers and the future `nvidia` slot).
  const leftovers: string[] = [];
  for (const [name, p] of providers) {
    if (tried.has(name)) continue;
    if (!p.available()) continue;
    if (_quotaExhausted.has(name)) continue;
    if (providerHealth.isBlocked(name)) continue;
    leftovers.push(name);
  }
  const rankedLeftovers = providerHealth.rankCandidates(leftovers);
  for (const name of rankedLeftovers) {
    const p = providers.get(name);
    if (p) {
      log.warn(`Chat: falling back to non-canonical provider "${name}"`);
      return p;
    }
  }

  // 4. Last resort — try anything still alive, including exhausted/blocked.
  //    Walking FALLBACK_ORDER preserves the previous "predictable last
  //    resort" behaviour the dashboard relies on.
  for (const name of FALLBACK_ORDER) {
    const p = providers.get(name);
    if (p?.available()) {
      log.warn(`Chat: all healthy providers exhausted, trying "${name}" as last resort`);
      return p;
    }
  }

  return null;
}

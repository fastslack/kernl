import { log } from "../logger.js";
import { detectLmStudio } from "./lmstudio-detect.js";
import type { ChatMessage, ChatCompletionResult, ChatCompletionOptions, ToolUseBlock } from "./chat-types.js";
import { ADAPTER_TIMEOUT_MS, truncateTools, type ChatLlmProvider } from "./chat-provider.js";
import { kernelMessagesToResponsesInput } from "./chat-messages.js";
import { retryWithBackoff } from "./retry.js";

// ── LMStudio (OpenAI Responses API) ──────────────────
// LM Studio exposes the OpenAI Responses API at /v1/responses. Compared with
// /v1/chat/completions: tools are flat (no `function: {...}` wrapper), system
// prompt goes in `instructions`, conversation history is an array of "items"
// passed via `input`, and the answer arrives as `output[]` with item types
// `message` (text), `function_call` (tool_use), and `reasoning` (ignored).
// Multi-turn tool flows pass back `function_call_output` items keyed by `call_id`.

const LMSTUDIO_DEFAULT_BASE = "http://localhost:1234/v1";

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
          signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS),
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

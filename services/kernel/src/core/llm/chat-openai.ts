/** OpenAI chat/completions adapter — OpenAI itself and every compatible API
 *  (NVIDIA, Groq, Gemini, xAI, DeepSeek, Ollama, …), keyed by `name`. */
import type { ChatMessage, ChatCompletionResult, ChatCompletionOptions, ToolUseBlock } from "./chat-types.js";
import { ADAPTER_TIMEOUT_MS, truncateTools, type ChatLlmProvider } from "./chat-provider.js";
import { kernelMessagesToOpenAi } from "./chat-messages.js";
import { applyModelQuirks } from "./provider-catalog.js";
import { stripReasoning } from "./strip-reasoning.js";
import { retryWithBackoff } from "./retry.js";
import { markProviderExhausted } from "./provider-quota.js";

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
    applyModelQuirks(body, this.name, model);
    fitOpenAiParams(body, this.name, model);
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
        signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS),
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

/**
 * OpenAI's own API changed two request parameters under Kernl's feet:
 *
 *   - `max_tokens` is refused by the reasoning models (GPT-5, o1/o3/o4…):
 *     "Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens'".
 *     Every chat model on api.openai.com accepts `max_completion_tokens`, so
 *     the official provider always gets that name.
 *   - The same reasoning models only take the default sampling: a
 *     `temperature` other than 1 (or a `top_p`) is a 400 too.
 *   - Their token cap covers the reasoning as well as the answer: a probe
 *     asking for 1024 tokens got them all spent thinking and came back empty.
 *     They get a floor of REASONING_MIN_TOKENS; only what is used is billed.
 *
 * OpenAI-compatible providers (NVIDIA, Groq, OpenRouter, LM Studio…) keep
 * `max_tokens`: several of them do not know the newer name.
 */

/** Models that reason before answering and only accept default sampling. */
const REASONING = /^(gpt-5|o[1-9])(\b|[-.])/i;
const REASONING_MIN_TOKENS = 8192;

export function fitOpenAiParams(body: Record<string, unknown>, slug: string, model: string): void {
  if (slug !== "openai") return;
  if ("max_tokens" in body) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }
  if (REASONING.test(model)) {
    if (body.temperature !== undefined && body.temperature !== 1) delete body.temperature;
    delete body.top_p;
    const cap = Number(body.max_completion_tokens);
    if (Number.isFinite(cap) && cap < REASONING_MIN_TOKENS) body.max_completion_tokens = REASONING_MIN_TOKENS;
  }
}

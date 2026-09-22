/** Anthropic Messages API chat adapter (API key, metered). */
import type { ChatMessage, ChatCompletionResult, ChatCompletionOptions, ToolUseBlock } from "./chat-types.js";
import { ADAPTER_TIMEOUT_MS, truncateTools, type ChatLlmProvider } from "./chat-provider.js";
import { retryWithBackoff } from "./retry.js";
import { markProviderExhausted } from "./provider-quota.js";

// ── Claude ───────────────────────────────────────────

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-4-20250514";

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
        signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS),
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

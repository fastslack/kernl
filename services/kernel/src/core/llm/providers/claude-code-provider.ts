/**
 * Built-in LLM provider — Claude Code (Anthropic Agent SDK).
 *
 * Unlike `claude-provider.ts` it makes NO direct HTTP call to the API. It spawns
 * binario `claude` (Claude Code CLI) via `@anthropic-ai/claude-agent-sdk` y
 * uses the OAuth token stored in `~/.claude.json` — the Max/Pro subscription
 * subscription. It isn't billed per token while the subscription covers usage.
 *
 * Capabilities distintivas vs el provider API:
 *   - skills    — scripts por task en ~/.claude/skills/
 *   - plugins   — bundles (skills + agents + commands) de marketplaces
 *   - mcpServers — MCPs per-run
 *   - built-in tools del CLI (Bash/Read/Edit/Grep/Glob/Task/WebFetch/WebSearch)
 *
 * Wrapper alrededor de `ChatClaudeCodeProvider` en `chat/claude-code-provider.ts`.
 */

import { ChatClaudeCodeProvider } from "../claude-code-adapter.js";
import type {
  LlmProvider,
  LlmProviderCapabilities,
  LlmProviderStatus,
  ChatMessage,
  ChatCompletionOptions,
  ChatCompletionResult,
  ConfigField,
} from "../provider.js";

const CAPS: LlmProviderCapabilities = {
  tools: false,         // tool-calling is handled inside the SDK, not exposed to the caller
  streaming: false,
  thinking: true,
  vision: true,
  promptCaching: true,
  contextWindow: 200_000,
};

class ClaudeCodeProviderImpl implements LlmProvider {
  readonly slug = "claude-code";
  readonly name = "Claude Code (SDK)";
  readonly capabilities = CAPS;

  private impl: ChatClaudeCodeProvider | null = null;
  private defaultModel = "claude-sonnet-4-5";
  private lastError?: string;
  private lastModel?: string;

  configure(config: Record<string, unknown>): void {
    if (typeof config.defaultModel === "string" && config.defaultModel) {
      this.defaultModel = config.defaultModel;
    }
  }

  async start(): Promise<void> {
    this.impl = new ChatClaudeCodeProvider(this.defaultModel);
    this.lastError = this.impl.available() ? undefined : "Claude Code CLI not found — run `claude login`.";
  }

  async stop(): Promise<void> {
    this.impl = null;
  }

  isReady(): boolean {
    return this.impl?.available() ?? false;
  }

  getStatus(): LlmProviderStatus {
    return {
      slug: this.slug,
      name: this.name,
      ready: this.isReady(),
      capabilities: this.capabilities,
      lastModel: this.lastModel,
      error: this.lastError,
    };
  }

  getConfigSchema(): ConfigField[] {
    return [
      { key: "defaultModel", label: "Default model", type: "text", required: false, placeholder: "claude-sonnet-4-5" },
    ];
  }

  /** Models the Claude Agent SDK can target via the CLI. Curated — the SDK
   *  doesn't expose a remote /models endpoint; the list mirrors what `claude`
   *  accepts as `--model`. */
  async listModels(): Promise<string[]> {
    return [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ];
  }

  async chatCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    if (!this.impl) throw new Error("Claude Code provider not started");
    const result = await this.impl.chatCompletion(
      messages as unknown as Parameters<ChatClaudeCodeProvider["chatCompletion"]>[0],
      opts as unknown as Parameters<ChatClaudeCodeProvider["chatCompletion"]>[1],
    );
    this.lastModel = result.model;
    return {
      content: result.content,
      model: result.model,
      stop_reason: result.stop_reason,
      usage: {
        input_tokens: 0,
        output_tokens: result.tokens_used,
      },
    };
  }
}

export const createClaudeCodeProvider = (): LlmProvider => new ClaudeCodeProviderImpl();

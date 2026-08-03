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
import { hasStoredCredential } from "../claude-code-auth.js";
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
    // Deliberately not seeding `lastError` with an unreadiness message.
    // `syncProvidersToKernelConfig` mirrors the stored oauthToken into
    // CLAUDE_CODE_OAUTH_TOKEN *after* providers start, so a message computed
    // here says "not signed in" about an account that is about to load — and
    // then survives as a stale string under a status that reads ready.
    // `describeUnreadiness()` answers live instead; `lastError` is only for
    // failures observed while actually calling the provider.
  }

  async stop(): Promise<void> {
    this.impl = null;
  }

  /**
   * Installed AND signed in.
   *
   * The binary alone used to be enough, and the Agent SDK bundles that binary,
   * so this returned true on every install ever made — including ones with no
   * account at all. Settings showed a green provider, the chain picked it as
   * the primary link, and every call failed with "Not logged in". Presence of a
   * credential is the honest floor; whether it still works is what the
   * readiness probe answers.
   */
  isReady(): boolean {
    if (!this.impl?.available()) return false;
    return hasStoredCredential();
  }

  private describeUnreadiness(): string | undefined {
    if (!this.impl?.available()) return "Claude Code CLI not found.";
    if (!hasStoredCredential()) return "Claude Code is installed but not signed in — run `claude login`.";
    return undefined;
  }

  getStatus(): LlmProviderStatus {
    // Computed per call, not read from `start()`. Signing in is exactly the
    // event that changes this answer, and it happens long after start — a
    // cached string would keep telling the operator to log in after they had.
    return {
      slug: this.slug,
      name: this.name,
      ready: this.isReady(),
      capabilities: this.capabilities,
      lastModel: this.lastModel,
      error: this.describeUnreadiness() ?? this.lastError,
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

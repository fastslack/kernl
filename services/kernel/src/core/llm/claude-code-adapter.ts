/**
 * ChatClaudeCodeProvider — chat completions via the logged-in Claude Code CLI.
 *
 * Uses `@anthropic-ai/claude-agent-sdk`'s `query()` which spawns the `claude`
 * binary. With `ANTHROPIC_API_KEY` stripped from the child env, the CLI falls
 * back to the OAuth creds in `~/.claude.json` — the user's Max/Pro
 * subscription. Zero API-key billing while the subscription covers usage.
 *
 * Two entry points:
 *   - `chatCompletion()` — single-shot, final-text-only. Used by the legacy
 *     synchronous `/api/chat/message` endpoint and by any chat fallback that
 *     wants an OpenAI-shaped reply.
 *   - `chatCompletionStream()` — full SDK loop with built-in tools (Read,
 *     Edit, Write, Bash, Grep, Glob, WebFetch, WebSearch, Task), kernel MCP
 *     tools, subagents, skills, and a `canUseTool` hook the dashboard wires
 *     to a permission modal. Events stream into a sink — text deltas,
 *     tool_use/tool_result blocks, permission prompts, session ids, done.
 *
 * Sessions: when the caller passes `sessionId`, we `resume` the SDK session
 * so structured tool_use history persists across turns instead of being
 * re-flattened into a transcript every time.
 */

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import {
  query,
  type Options,
  type SDKUserMessage,
  type PermissionResult,
  type CanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";
import { newId } from "../helpers.js";
import { resolveDefaultSocketPath as resolveKernelMcpSocketPath } from "../mcp-unix-socket.js";
import { claudeAuthEnv } from "./claude-code-auth.js";
import type {
  ChatMessage,
  ChatCompletionResult,
  ChatCompletionOptions,
  ContentBlock,
  ChatStreamSink,
  PermissionRequester,
} from "./chat-types.js";

const DEFAULT_MODEL = "claude-sonnet-4-5";

/**
 * Injectable config for the Claude Code provider (from
 * `config.claudeCode`). Every field is optional; when omitted the resolver
 * falls back to the same `process.env` reads the provider used before, so
 * config-less construction sites (the zero-arg `new ChatClaudeCodeProvider()`
 * in client.ts / registry provider) behave identically.
 */
export interface ClaudeCodeProviderOptions {
  /** KERNEL_MCP_URL — HTTP MCP endpoint when transport = "http". */
  mcpUrl?: string;
  /** KERNEL_MCP_BRIDGE — path to the stdio bridge script. Empty → derive from cwd. */
  mcpBridgePath?: string;
  /** KERNEL_MCP_TRANSPORT — "stdio" | "http". */
  mcpTransport?: string;
  /** CLAUDE_CODE_PATH — explicit path to the `claude` binary. */
  cliPath?: string;
  /**
   * A long-lived token from `claude setup-token`, for hosts where the
   * interactive login cannot run (no PTY). Injected as CLAUDE_CODE_OAUTH_TOKEN.
   */
  oauthToken?: string;
  /**
   * CLAUDE_CODE_DEFAULT_MODEL — the model picked for this provider in
   * Settings.
   *
   * It needs its own home because the constructor's `defaultModel` argument
   * carries the kernel-wide default. Without it the per-provider choice was
   * stored, rendered back in the dropdown, and read by nobody: you selected
   * claude-opus-4-7, saved, and every call still went out on
   * claude-sonnet-4-5.
   */
  model?: string;
}

/**
 * Built-in Claude Code tools the chat surface is allowed to use without
 * special opt-in. Bash/Write/Edit are powerful — the dashboard's
 * `canUseTool` hook gates each call.
 */
const DEFAULT_BUILTIN_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Edit",
  "Write",
  "Bash",
  "Task",
  "NotebookEdit",
  "SlashCommand",
  "ToolSearch",
];

/** Hosts considered "kernel local" — same allow-list as the agent executor. */
const KERNEL_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "kernel"]);

function isLocalMcpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return KERNEL_LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function resolveKernelMcpUrl(cfg?: ClaudeCodeProviderOptions): string {
  const raw = cfg?.mcpUrl ?? process.env.KERNEL_MCP_URL ?? "http://localhost:3087/mcp";
  if (!isLocalMcpUrl(raw)) {
    log.error(
      `SECURITY: KERNEL_MCP_URL "${raw}" is not a local kernel endpoint. Falling back to http://localhost:3087/mcp.`,
    );
    return "http://localhost:3087/mcp";
  }
  return raw;
}

/** Path to the stdio bridge the SDK spawns as the "kernel" MCP server.
 *  `||` (not `??`) so an empty injected/config value derives from cwd. */
function resolveKernelMcpBridgePath(cfg?: ClaudeCodeProviderOptions): string {
  return cfg?.mcpBridgePath
    || process.env.KERNEL_MCP_BRIDGE
    || `${process.cwd()}/bin/mcp-stdio-bridge.ts`;
}

/** Same selector as the claude_code agent executor — default to stdio bridge
 *  so chat completions survive the SDK's bwrap --unshare-net sandbox. */
function resolveKernelMcpServerConfig(cfg?: ClaudeCodeProviderOptions): import("@anthropic-ai/claude-agent-sdk").McpServerConfig {
  const transport = (cfg?.mcpTransport ?? process.env.KERNEL_MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http") {
    return { type: "http" as const, url: resolveKernelMcpUrl(cfg) };
  }
  return {
    type: "stdio" as const,
    command: process.execPath,
    args: [resolveKernelMcpBridgePath(cfg), resolveKernelMcpSocketPath()],
    env: { KERNEL_MCP_SOCKET: resolveKernelMcpSocketPath() },
  };
}

/** Dirs the SDK's bwrap sandbox MUST bind so the stdio bridge can (a) be
 *  spawned and (b) reach the kernel MCP Unix socket. WITHOUT these, the
 *  bridge runs inside a fresh-tmpfs sandbox where /tmp/kernl-mcp.sock
 *  doesn't exist → "cannot connect … ENOENT" → the "kernel" MCP server stays
 *  `pending` forever and every mcp__kernel__* tool is unreachable. Mirrors the
 *  agent executor's `extraDirs`. */
function resolveKernelSandboxDirs(cfg?: ClaudeCodeProviderOptions): string[] {
  const dirOf = (p: string) => p.replace(/\/[^/]+$/, "") || "/";
  const socketDir = dirOf(resolveKernelMcpSocketPath());
  const bridgeDir = dirOf(resolveKernelMcpBridgePath(cfg));
  return [...new Set([socketDir, bridgeDir])];
}

export interface ChatStreamCallOptions {
  model?: string;
  system?: string;
  sessionId?: string;
  permission?: PermissionRequester;
  /** When undefined, default built-in toolset is used. When [], all tools disabled. */
  allowedTools?: string[];
  /** Tools the SDK loop must NOT offer to the model. Use to strip a few
   *  noisy built-ins (Bash, ToolSearch, WebFetch…) while leaving the rest
   *  + the kernel MCP server untouched. */
  disallowedTools?: string[];
  /** Working directory for filesystem tools. Defaults to process.cwd(). */
  cwd?: string;
  /** When true, pass `settingSources: []` to the SDK so the session ignores
   *  host user settings (plugins, user-scope MCP servers from the bind-
   *  mounted ~/.claude.json). Keeps focused chats (e.g. the commander panel)
   *  fast to boot and limited to built-ins + the injected kernel server. */
  isolateSettings?: boolean;
  signal?: AbortSignal;
}

export class ChatClaudeCodeProvider {
  readonly name = "claude_code";
  /**
   * `chatCompletion()` below is a single-turn shim: maxTurns 1, allowedTools
   * empty, kernel tools explicitly ignored. It cannot carry a tool loop, and
   * handing it one produces "Reached maximum number of turns (1)" rather than
   * a clear refusal. Callers that need tools skip this provider on this flag.
   * The full SDK loop lives in the streaming path, which agents reach through
   * executor_type "claude_code" instead.
   */
  readonly supportsToolLoop = false;
  private cachedBin: string | null | undefined = undefined;

  constructor(
    defaultModel: string = DEFAULT_MODEL,
    private cfg: ClaudeCodeProviderOptions = {},
  ) {
    // The provider's own setting wins over the kernel-wide default; the
    // argument is the fallback for when nothing was chosen for this provider.
    this.defaultModel = cfg.model || defaultModel || DEFAULT_MODEL;
  }

  private defaultModel: string;

  available(): boolean {
    return !!this.findBinary();
  }

  /** Where the CLI was resolved to, for the sign-in dialog to report. */
  binaryPath(): string | undefined {
    return this.findBinary();
  }

  /**
   * Single-shot, text-only completion. Kept for the legacy synchronous chat
   * path and for fallbacks — tools/turns are intentionally locked down so
   * the response is a pure final-text reply, no kernel side-effects.
   */
  async chatCompletion(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    const bin = this.findBinary();
    if (!bin) {
      throw new Error(
        `claude_code provider: CLI not found. Install Claude Code (\`claude login\`) to use your Max/Pro subscription.`,
      );
    }

    if (opts?.tools && opts.tools.length > 0) {
      logToolIgnoredOnce();
    }

    const model = opts?.model || this.defaultModel;
    const lastUser = this.lastUserMessage(messages);
    if (!lastUser) {
      throw new Error("claude_code provider: no user message to send");
    }

    const childEnv = this.buildChildEnv();
    const system = this.buildTranscriptSystem(opts?.system, messages);
    const promptIterable = this.buildPromptStream(lastUser);

    const options: Options = {
      model,
      maxTurns: 1,
      systemPrompt: { type: "preset", preset: "claude_code", append: system },
      permissionMode: "dontAsk",
      allowedTools: [],
      persistSession: false,
      pathToClaudeCodeExecutable: bin,
      env: childEnv,
      sandbox: { enabled: false, failIfUnavailable: false },
    };

    let finalText = "";
    let totalTokens = 0;
    let stopReason: string | undefined;
    let authFailed = false;

    const q = query({ prompt: promptIterable, options });
    try {
      for await (const msg of q) {
        if (msg.type === "assistant") {
          const blocks = (msg.message as { content?: unknown }).content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
                finalText += (b as { text?: string }).text ?? "";
              }
            }
          }
          if (msg.error === "authentication_failed") authFailed = true;
        } else if (msg.type === "result") {
          if ("result" in msg && typeof msg.result === "string" && msg.result) {
            finalText = msg.result;
          }
          if ("usage" in msg && msg.usage) {
            const u = msg.usage as { input_tokens?: number; output_tokens?: number };
            totalTokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
          }
          if ("stop_reason" in msg && typeof msg.stop_reason === "string") {
            stopReason = msg.stop_reason ?? undefined;
          }
        }
      }
    } finally {
      try { q.close(); } catch { /* already closed */ }
    }

    if (authFailed) {
      throw new Error(
        "claude_code: OAuth authentication failed. Run `claude login` to refresh credentials.",
      );
    }
    if (!finalText) {
      throw new Error("claude_code: empty response from Claude Agent SDK");
    }

    return {
      content: finalText,
      model,
      tokens_used: totalTokens,
      stop_reason: stopReason,
    };
  }

  /**
   * Streaming completion — the "real" Claude Code experience for the chat
   * UI. Pumps SDK messages into `sink` and returns once the SDK loop is
   * done. Built-in tools + kernel MCP are enabled; the dashboard handles
   * permissions via the `permission` callback.
   */
  async chatCompletionStream(
    userText: string,
    sink: ChatStreamSink,
    opts: ChatStreamCallOptions,
  ): Promise<{
    finalText: string;
    tokensUsed: number;
    stopReason?: string;
    sessionId?: string;
  }> {
    const bin = this.findBinary();
    if (!bin) {
      throw new Error(
        `claude_code provider: CLI not found. Install Claude Code (\`claude login\`) to use your Max/Pro subscription.`,
      );
    }

    const model = opts.model || this.defaultModel;
    const childEnv = this.buildChildEnv();
    const cwd = opts.cwd ?? process.cwd();
    const allowed = opts.allowedTools ?? DEFAULT_BUILTIN_TOOLS;

    // Hook canUseTool only when the caller provided a permission requester.
    // Without it we fall back to bypassPermissions so the SDK doesn't block.
    const canUseTool: CanUseTool | undefined = opts.permission
      ? async (toolName, toolInput) => {
          const requestId = newId();
          sink({
            type: "permission_request",
            request_id: requestId,
            tool_name: toolName,
            input: (toolInput ?? {}) as Record<string, unknown>,
          });
          try {
            const decision = await opts.permission!.ask({
              request_id: requestId,
              tool_name: toolName,
              input: (toolInput ?? {}) as Record<string, unknown>,
            });
            if (decision.behavior === "allow") {
              return {
                behavior: "allow",
                updatedInput: toolInput,
              } as PermissionResult;
            }
            return {
              behavior: "deny",
              message: decision.reason || "Denied by dashboard user.",
            } as PermissionResult;
          } catch (err) {
            return {
              behavior: "deny",
              message:
                err instanceof Error
                  ? `Permission request failed: ${err.message}`
                  : "Permission request failed.",
            } as PermissionResult;
          }
        }
      : undefined;

    const options: Options = {
      model,
      cwd,
      maxTurns: 50,
      systemPrompt: opts.system
        ? { type: "preset", preset: "claude_code", append: opts.system }
        : { type: "preset", preset: "claude_code" },
      // With canUseTool we use "default" — the SDK calls our hook for each
      // tool. Without it the SDK would block, so we bypass when no hook.
      permissionMode: canUseTool ? "default" : "bypassPermissions",
      allowDangerouslySkipPermissions: !canUseTool,
      canUseTool,
      allowedTools: allowed.length > 0 ? allowed : undefined,
      disallowedTools: (opts.disallowedTools && opts.disallowedTools.length > 0) ? opts.disallowedTools : undefined,
      // Always inject the kernel as MCP server "kernel" so kernel_* tools and
      // forwarded mcp_* bridges are reachable from the SDK loop. Defaults to
      // the stdio bridge (kernel_agents_call_meeting et al would otherwise be
      // unreachable under the SDK's --unshare-net bwrap sandbox).
      mcpServers: {
        kernel: resolveKernelMcpServerConfig(this.cfg),
      },
      // Bind the socket + bridge dirs into the bwrap sandbox so the stdio
      // bridge can spawn AND reach the kernel MCP Unix socket. Omitting this
      // is what left the "kernel" MCP server stuck `pending` (ENOENT on the
      // socket) and every mcp__kernel__* tool unreachable in chat.
      additionalDirectories: resolveKernelSandboxDirs(this.cfg),
      // Isolated sessions skip host user settings entirely — no host plugins,
      // no user-scope MCP servers, just built-ins + the kernel server above.
      ...(opts.isolateSettings ? { settingSources: [] as [] } : {}),
      // Carry the SDK's own session forward when we have one — keeps
      // structured tool_use history across turns.
      resume: opts.sessionId || undefined,
      persistSession: true,
      pathToClaudeCodeExecutable: bin,
      env: childEnv,
      // Local bwrap sandbox the SDK ships with — keep filesystem writes
      // scoped without forcing the user to wire docker sandboxes for chat.
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: true,
        network: { allowLocalBinding: true, allowAllUnixSockets: true },
      },
    };

    let finalText = "";
    let totalTokens = 0;
    let stopReason: string | undefined;
    let authFailed = false;
    let sessionId: string | undefined = opts.sessionId;

    const promptIterable = this.buildPromptStream({ role: "user", content: userText });
    const q = query({ prompt: promptIterable, options });

    // Allow upstream cancellation (e.g. user navigates away).
    const onAbort = () => {
      try { q.close(); } catch { /* ignore */ }
    };
    opts.signal?.addEventListener("abort", onAbort);

    try {
      for await (const msg of q) {
        if (msg.type === "system") {
          if (msg.subtype === "init" && "session_id" in msg && typeof msg.session_id === "string") {
            sessionId = msg.session_id;
            sink({ type: "session", session_id: msg.session_id });
          }
          sink({
            type: "system",
            subtype: msg.subtype,
            data: msg as unknown as Record<string, unknown>,
          });
        } else if (msg.type === "assistant") {
          const blocks = (msg.message as { content?: unknown }).content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (!b || typeof b !== "object") continue;
              const block = b as { type?: string };
              if (block.type === "text") {
                const text = (b as { text?: string }).text ?? "";
                if (text) {
                  finalText += text;
                  sink({ type: "assistant_text", text });
                }
              } else if (block.type === "thinking") {
                const text = (b as { thinking?: string; text?: string }).thinking
                  ?? (b as { text?: string }).text ?? "";
                if (text) sink({ type: "thinking", text });
              } else if (block.type === "tool_use") {
                const u = b as { id?: string; name?: string; input?: unknown };
                sink({
                  type: "tool_use",
                  id: u.id ?? "",
                  name: u.name ?? "",
                  input: (u.input ?? {}) as Record<string, unknown>,
                });
              }
            }
          }
          if (msg.error === "authentication_failed") authFailed = true;
        } else if (msg.type === "user") {
          // Tool results come back as user messages with tool_result blocks.
          const userMsg = msg.message as { content?: unknown };
          if (Array.isArray(userMsg.content)) {
            for (const b of userMsg.content) {
              if (!b || typeof b !== "object") continue;
              const block = b as { type?: string };
              if (block.type === "tool_result") {
                const r = b as {
                  tool_use_id?: string;
                  content?: unknown;
                  is_error?: boolean;
                };
                sink({
                  type: "tool_result",
                  tool_use_id: r.tool_use_id ?? "",
                  content: stringifyToolResult(r.content),
                  is_error: !!r.is_error,
                });
              }
            }
          }
        } else if (msg.type === "result") {
          if ("result" in msg && typeof msg.result === "string" && msg.result) {
            finalText = msg.result;
          }
          if ("usage" in msg && msg.usage) {
            const u = msg.usage as { input_tokens?: number; output_tokens?: number };
            totalTokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
          }
          if ("stop_reason" in msg && typeof msg.stop_reason === "string") {
            stopReason = msg.stop_reason ?? undefined;
          }
          if (
            "session_id" in msg &&
            typeof (msg as { session_id?: unknown }).session_id === "string"
          ) {
            sessionId = (msg as { session_id: string }).session_id;
          }
        }
      }
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      try { q.close(); } catch { /* already closed */ }
    }

    if (authFailed) {
      throw new Error(
        "claude_code: OAuth authentication failed. Run `claude login` to refresh credentials.",
      );
    }

    return { finalText, tokensUsed: totalTokens, stopReason, sessionId };
  }

  /** Single-shot async iterable around a user turn. */
  private buildPromptStream(lastUser: ChatMessage): AsyncIterable<SDKUserMessage> {
    const content = lastUser.content;
    return (async function* () {
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: typeof content === "string" ? content : (content as unknown as never),
        },
      } as SDKUserMessage;
    })();
  }

  /** Build the legacy single-shot system prompt that carries the transcript. */
  private buildTranscriptSystem(explicitSystem: string | undefined, messages: ChatMessage[]): string {
    const parts: string[] = [];
    if (explicitSystem) parts.push(explicitSystem);
    const history = messages.slice(0, -1);
    if (history.length > 0) {
      parts.push(
        "## Conversation so far\n" +
          history
            .map((m) => `**${m.role}**: ${this.renderForTranscript(m.content)}`)
            .join("\n\n"),
      );
    }
    return parts.filter(Boolean).join("\n\n");
  }

  private renderForTranscript(content: string | ContentBlock[]): string {
    if (typeof content === "string") return content;
    const out: string[] = [];
    for (const b of content) {
      if (b.type === "text") out.push(b.text);
      else if (b.type === "image") out.push("[image attached]");
      else if (b.type === "document") out.push("[pdf attached]");
      else if (b.type === "tool_use") out.push(`[tool_use ${b.name}]`);
      else if (b.type === "tool_result") out.push(`[tool_result]`);
    }
    return out.join(" ");
  }

  private lastUserMessage(messages: ChatMessage[]): ChatMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i];
    }
    return null;
  }

  /** Strip API keys + redirect HOME for OAuth, same as agent executor. */
  private buildChildEnv(): Record<string, string | undefined> {
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: "kernl-chat/0.1",
    };
    childEnv.ANTHROPIC_API_KEY = undefined;
    childEnv.ANTHROPIC_AUTH_TOKEN = undefined;
    if (process.env.HOST_HOME) childEnv.HOME = process.env.HOST_HOME;
    // Credentials live in the kernel's own config dir, not $HOME — under Docker
    // $HOME is the image layer, so a `--force-recreate` threw the login away and
    // every LLM feature started failing with "Not logged in". Assigned last so
    // it also wins over the HOST_HOME redirect above.
    Object.assign(childEnv, claudeAuthEnv({ oauthToken: this.cfg.oauthToken }));
    return childEnv;
  }

  /** Mirror of ClaudeCodeExecutor.findClaudeCodeBinary with the same resolution order. */
  private findBinary(): string | undefined {
    if (this.cachedBin !== undefined) return this.cachedBin ?? undefined;

    const override = this.cfg.cliPath || process.env.CLAUDE_CODE_PATH;
    if (override && existsSync(override)) {
      this.cachedBin = override;
      return override;
    }

    try {
      const path = execSync("which claude", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (path && existsSync(path)) {
        this.cachedBin = path;
        return path;
      }
    } catch { /* not in PATH */ }

    const hostCli = process.env.HOST_CLAUDE_CLI;
    if (hostCli && existsSync(hostCli)) {
      this.cachedBin = hostCli;
      return hostCli;
    }

    const candidates = [
      `${process.env.HOME ?? ""}/.local/bin/claude`,
      "/usr/local/bin/claude",
      "/usr/bin/claude",
      resolve(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"),
      "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        this.cachedBin = c;
        return c;
      }
    }

    this.cachedBin = null;
    return undefined;
  }
}

/** Coerce SDK tool_result content (string | content blocks) into plain text. */
function stringifyToolResult(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const block = b as { type?: string; text?: string };
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

let _toolIgnoreLogged = false;
function logToolIgnoredOnce(): void {
  if (_toolIgnoreLogged) return;
  _toolIgnoreLogged = true;
  log.warn(
    `claude_code provider: kernel tools are ignored in single-shot mode. Use chatCompletionStream() for full SDK loop.`,
  );
}

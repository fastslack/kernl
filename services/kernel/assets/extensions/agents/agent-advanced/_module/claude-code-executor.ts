/**
 * ClaudeCodeExecutor — delegates an agent run to the Claude Agent SDK.
 *
 * Usage model: agents with `executor_type = 'claude_code'` run here. The SDK
 * lanza un subproceso (Claude Code CLI embebido) con tools built-in (Bash,
 * Read, Edit, Write, Grep, Glob, Task, WebFetch, WebSearch) + MCPs opcionales,
 * en un workspace propio (`data/workspaces/agent-<id>/`).
 *
 * The progress signal (system messages, tool calls, tool results, final text)
 * is translated into the same events the native AgentExecutor emits
 * (`agent:flow:run_started`, `agent:flow:step`, `agent:flow:run_completed`) y
 * is persisted via `service.addStep` / `service.logEvent`, so the 3D UI and
 * dashboard never notice the engine swap.
 *
 * What it deliberately does NOT include (to keep coding agents lightweight):
 * - Office inbox, fleet-wide directory, hierarchy — the SDK is fed by
 *   su propio cwd/sandbox, estos constructos sociales aplican al native flow.
 * - Auto-eval / reflection — can be bolted on later via a post-run hook.
 * - Declarative chains — fired from the router (AgentExecutor) when needed.
 */

import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  query,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { log } from "../../../../../src/core/logger.js";
import { resolveDefaultSocketPath as resolveKernelMcpSocketPath } from "../../../../../src/core/mcp-unix-socket.js";
import { logLlmStart, logLlmEnd, logLlmFail } from "../../../../../src/core/llm/logger.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { Agent, AgentRun, AgentFlow } from "../../../../../src/modules/agents/types.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import { seedOfficeHome, officeHomeGuidance } from "../../../../../src/modules/agents/office-home.js";
import type { ExecutionResult } from "../../../../../src/modules/agents/executor.js";
import { resolveAgentSystemPrompt, resolveAgentLanguage } from "../../../../../src/modules/agents/i18n.js";
import {
  promptTodayDate,
  promptClaudeCodeWorkInstructions,
  promptLearningsBlock,
  promptStyleDirective,
} from "../../../../../src/core/i18n/prompts.js";
import type { SandboxDriverRegistry } from "../../../../../src/core/sandbox/registry.js";
import type { SandboxHandle, SandboxRunOptions } from "../../../../../src/core/sandbox/driver.js";
import type { WorkspaceService } from "./workspace-service.js";

export interface ClaudeCodeExecuteParams {
  agent: Agent;
  goal: string;
  run: AgentRun;
  service: AgentService;
  events?: EventBus;
  depth?: number;
}

/** Shape of an optional per-agent MCP config injected through `variables`. */
interface AgentVariablesMcp {
  __mcp_servers__?: Record<string, McpServerConfig>;
  __permission_mode__?: PermissionMode;
  __additional_directories__?: string[];
  __env__?: Record<string, string>;
  /**
   * @deprecated OAuth (CLI subscription) is now the default whenever the
   * `claude` binary is available. This flag is kept only for backward compat
   * and has no effect beyond the default behavior.
   */
  __prefer_oauth__?: boolean;
  /**
   * Opt-in to force the billable Anthropic API key even when the Claude Code
   * CLI is logged in. Only set this for agents that must run headless on a
   * machine without the CLI session (CI, remote deploys). Default: false —
   * OAuth is preferred to avoid double-charging your Max/Pro subscription.
   */
  __prefer_api_key__?: boolean;
  /**
   * OS-level sandbox via bubblewrap. Default: true. Pass `false` to disable it
   * (e.g. deploy agents that need broad access to the container FS).
   */
  __sandbox__?: boolean;
  /**
   * @deprecated Use `__sandbox_driver__` instead.
   * When true, defaults to the "docker" driver for backward compat.
   */
  __container_sandbox__?: boolean;
  /**
   * Selects a sandbox driver from SandboxDriverRegistry. Built-in values:
   *   - "docker"        → Docker container (isolation via namespaces)
   *   - "cubesandbox"   → CubeSandbox MicroVM (KVM, sub-60ms cold start)
   *   - undefined / ""  → no sandbox (runs in host namespace)
   * Custom drivers from extensions use whatever slug the manifest declares.
   */
  __sandbox_driver__?: string;
  /**
   * Imagen Docker del sandbox. Default `oven/bun:1` (bun/node/git).
   * Drivers that model workspaces as templates/snapshots ignore this.
   */
  __sandbox_image__?: string;
  /** Snapshot / template id for drivers that support snapshot-clone workspaces. */
  __sandbox_snapshot__?: string;
  /** Per-run config overrides passed through to the driver. */
  __sandbox_config__?: Record<string, unknown>;
  /** Bloquea toda salida a red del subprocess. Default: false. */
  __no_network__?: boolean;
  /**
   * Lista de skills de Claude Code a cargar dentro del sandbox. Se resuelven
   * from ~/.claude/skills/ and the host plugins. The CLI auto-discovers them
   * una vez montados en $HOME/.claude/skills/<name>/.
   * Ej: ["frontend-design", "find-skills"]
   */
  __skills__?: string[];
  /**
   * List of Claude Code plugins to load into the sandbox. Accepts the format
   * "<marketplace>/<plugin>", or just "<plugin>" (searched across all marketplaces).
   * Se bind-mountan al container y se pasan al SDK via Options.plugins con
   * `type: 'local'`. Un plugin trae skills + agents + commands + hooks juntos.
   * Ej: ["claude-plugins-official/frontend-design", "matware/e2e-runner"]
   */
  __plugins__?: string[];
  /**
   * The agent's default workspace. Used when the run payload carries no
   * `workspace`. Handy for agents dedicated to one specific project.
   * Ej: "my-project" → cwd será data/workspaces/my-project/
   */
  __workspace__?: string;
  /**
   * Absolute path the agent uses as its cwd, instead of a workspace under
   * `data/workspaces/`. Useful when an agent is dedicated to driving a
   * project that lives outside the kernel (e.g. a landing page in another repo).
   *
   * Takes precedence over the payload's `workspace` and over `__workspace__`.
   * The path must exist and be absolute; otherwise we fall back to a workspace.
   * Ej: "/home/you/projects/some-landing"
   */
  __cwd_path__?: string;
  /**
   * Controls how the agent inherits user-scope config (`~/.claude.json` +
   * `~/.claude/settings.json`):
   *
   *   - `'isolate'` (default) → passes `settingSources: []` to the SDK. The agent
   *     ignores `~/.claude.json` + `~/.claude/settings.json` entirely and
   *     it only uses what we hand it explicitly (`mcpServers`, `plugins`).
   *     This is the default because when the kernel runs in a container the
   *     plugins/MCPs del host suelen fallar al arrancar (faltan tokens,
   *     puertos en uso) y el CLI dispara su guard "Uncaught exception loop
   *     detected (10 in 5000ms)" → a silent exit 1. Isolating the user-scope
   *     settings avoids that cascade.
   *
   *   - `'inherit'` → passes `settingSources: ['user']` to the SDK. The agent sees
   *     user-scope MCPs/plugins plus whatever overrides it declares here. Turn
   *     it on only when the agent genuinely needs the host marketplaces and
   *     you know the plugins will start up clean.
   */
  __settings_mode__?: "inherit" | "isolate";
}

/**
 * Whitelist for components interpolated into filesystem paths (and previously
 * shell commands) — agent IDs, marketplace/plugin/skill names. Anything with a
 * slash, dot, control char, or shell metacharacter is rejected outright. Length
 * cap mirrors the existing `__workspace__` regex for symmetry.
 */
function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * Hosts treated as "kernel-local" — i.e. the kernel's own HTTP server.
 * Anything else routed through `KERNEL_MCP_URL` or `vars.__mcp_servers__`
 * would let an agent be steered at an arbitrary endpoint, turning the
 * MCP channel into an SSRF + tool-poisoning vector.
 */
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

function resolveKernelMcpUrl(): string {
  const raw = process.env.KERNEL_MCP_URL ?? "http://localhost:3087/mcp";
  if (!isLocalMcpUrl(raw)) {
    log.error(`SECURITY: KERNEL_MCP_URL "${raw}" is not a local kernel endpoint. Falling back to http://localhost:3087/mcp.`);
    return "http://localhost:3087/mcp";
  }
  return raw;
}

/** Pick the MCP transport the subprocess will use to talk back to the kernel.
 *
 *  Two sandbox shapes need different transports:
 *
 *  1. Bwrap-inside-kernel (no sandbox driver, default for chat + most agents):
 *     The Agent SDK wraps the CLI in `bwrap --unshare-net`. HTTP to
 *     `localhost:3087` is unreachable — only Unix sockets survive
 *     (`allowAllUnixSockets: true`). Use the stdio bridge.
 *
 *  2. Docker sandbox (driverSlug = "docker", "cubesandbox", etc.):
 *     The SDK sandbox is DISABLED (sandbox: undefined) because the docker
 *     container is the actual boundary. The container's network is the
 *     compose bridge — `http://kernel:3087/mcp` resolves to the kernel
 *     service. Plain HTTP works; the stdio bridge does NOT (the bridge
 *     script is on the kernel container's FS, not bind-mounted into the
 *     agent container).
 *
 *  Override default via KERNEL_MCP_TRANSPORT={stdio,http}.
 */
function resolveKernelMcpServerConfig(caller: {
  agentId: string;
  runId: string;
  depth: number;
  usingDockerSandbox: boolean;
}): McpServerConfig {
  const explicit = process.env.KERNEL_MCP_TRANSPORT?.toLowerCase();
  const transport = explicit ?? (caller.usingDockerSandbox ? "http" : "stdio");
  if (transport === "http") {
    // Inside the docker sandbox container, `localhost:3087` loops back to
    // the agent container itself. We default to `kernel:3087` (the compose
    // service DNS), which only resolves when the agent container joins the
    // compose network — the executor takes care of that via `runOpts.network`
    // when usingDockerSandbox is true. Override via KERNEL_MCP_URL_FROM_SANDBOX
    // for non-compose topologies.
    const httpUrl = caller.usingDockerSandbox
      ? (process.env.KERNEL_MCP_URL_FROM_SANDBOX ?? "http://kernel:3087/mcp")
      : resolveKernelMcpUrl();
    // The kernel's HTTP API is fail-closed: without an Authorization header
    // /mcp answers 401, the "kernel" MCP server never finishes initializing,
    // and EVERY mcp__kernel__* tool is silently missing from the run — the
    // agent still starts, finds only its built-ins, and improvises. The token
    // is the same secret this process already holds; bootstrap republishes it
    // to KERNEL_AUTH_TOKEN precisely so the children it spawns can present it
    // (see core/bootstrap/databases.ts). Omitted when auth is disabled, so an
    // unauthenticated kernel keeps working.
    const authToken = process.env.KERNEL_AUTH_TOKEN?.trim();
    log.info(`claude_code MCP: http transport for agent=${caller.agentId.slice(0,8)} url=${httpUrl} sandbox=${caller.usingDockerSandbox ? "docker" : "bwrap-or-none"} auth=${authToken ? "bearer" : "none"}`);
    return {
      type: "http" as const,
      url: httpUrl,
      headers: {
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        "X-Caller-Agent-Id": caller.agentId,
        "X-Caller-Run-Id": caller.runId,
        "X-Caller-Depth": String(caller.depth),
      },
    };
  }
  // Bridge script lives next to bin/mcp-server.ts. The kernel module is
  // checked into the repo so cwd-relative path is stable across containers.
  const bridgePath = process.env.KERNEL_MCP_BRIDGE
    ?? `${process.cwd()}/bin/mcp-stdio-bridge.ts`;
  log.info(`claude_code MCP: stdio bridge for agent=${caller.agentId.slice(0,8)} bin=${process.execPath} bridge=${bridgePath} socket=${resolveKernelMcpSocketPath()}`);
  return {
    type: "stdio" as const,
    command: process.execPath, // same Node/Bun the kernel runs on
    args: [bridgePath, resolveKernelMcpSocketPath()],
    env: {
      KERNEL_CALLER_AGENT_ID: caller.agentId,
      KERNEL_CALLER_RUN_ID: caller.runId,
      KERNEL_CALLER_DEPTH: String(caller.depth),
      KERNEL_MCP_SOCKET: resolveKernelMcpSocketPath(),
      KERNEL_MCP_BRIDGE_DEBUG: process.env.KERNEL_MCP_BRIDGE_DEBUG ?? "",
    },
  };
}

/**
 * Filter user-supplied MCP server map. By default we drop anything whose URL
 * isn't local — agents shouldn't be able to inject arbitrary remote MCP
 * endpoints (each one is effectively a tool source the LLM is told to trust).
 * Operators can opt back in with KERNEL_ALLOW_REMOTE_AGENT_MCP=1.
 */
function sanitizeUserMcpServers(
  raw: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> {
  if (!raw || typeof raw !== "object") return {};
  const allowRemote = process.env.KERNEL_ALLOW_REMOTE_AGENT_MCP === "1";
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    if (name === "kernel") {
      // Reserved — the kernel binding is injected by the executor.
      log.warn(`agents: __mcp_servers__ tried to override "kernel"; ignored.`);
      continue;
    }
    if (!isSafeIdentifier(name)) {
      log.warn(`agents: __mcp_servers__ key "${name}" rejected (must match /^[A-Za-z0-9_-]{1,64}$/).`);
      continue;
    }
    const url = (cfg as { url?: unknown })?.url;
    if (typeof url === "string" && url && !isLocalMcpUrl(url) && !allowRemote) {
      log.warn(`agents: __mcp_servers__["${name}"] points at non-local URL "${url}"; ignored. Set KERNEL_ALLOW_REMOTE_AGENT_MCP=1 to allow.`);
      continue;
    }
    out[name] = cfg;
  }
  return out;
}

export class ClaudeCodeExecutor {
  private configRef: KernelConfig | null = null;
  private wsService: WorkspaceService | null = null;
  private sandboxRegistry: SandboxDriverRegistry | null = null;
  /** runId → AbortController, for external cancellation. */
  private activeRuns = new Map<string, AbortController>();
  /** Cached path to the Claude Code CLI — null = already searched, not found. */
  private cachedClaudeBin: string | null | undefined = undefined;
  /**
   * Auto-eval bridge — eval service + native executor (which owns the
   * autoEvaluate impl). Both injected at module init. Wiring via the native
   * executor avoids duplicating the SEPL grading + learnings extraction logic.
   */
  private evalService: import("./eval-service.js").AgentEvalService | null = null;
  private nativeExecutor: import("../../../../../src/modules/agents/executor.js").AgentExecutor | null = null;

  setConfig(config: KernelConfig): void {
    this.configRef = config;
  }

  setEvalService(evalService: import("./eval-service.js").AgentEvalService): void {
    this.evalService = evalService;
  }

  setNativeExecutor(executor: import("../../../../../src/modules/agents/executor.js").AgentExecutor): void {
    this.nativeExecutor = executor;
  }

  setWorkspaceService(ws: WorkspaceService): void {
    this.wsService = ws;
  }

  setSandboxRegistry(registry: SandboxDriverRegistry): void {
    this.sandboxRegistry = registry;
  }

  cancelRun(runId: string): boolean {
    const ctrl = this.activeRuns.get(runId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  getActiveRunIds(): string[] {
    return [...this.activeRuns.keys()];
  }

  async execute(params: ClaudeCodeExecuteParams): Promise<ExecutionResult> {
    const { agent, goal, run, service, events } = params;

    // Run.depth is set when a chain spawns this run (kernel_agents_invoke or
    // _run from inside another agent). The MCP transport sends it back to the
    // kernel via X-Caller-Depth so the next hop can keep counting.
    const currentDepth = Math.max(0, Number((run as { depth?: number }).depth ?? 0));

    const abortController = new AbortController();
    this.activeRuns.set(run.id, abortController);

    let stepNumber = 0;
    let totalTokens = 0;
    let finalText = "";
    let errorMsg = "";
    // Capture the `claude` subprocess stderr so that when the process dies
    // muera sin emitir un mensaje SDK útil (ej. "Credit balance is too low",
    // problemas de auth, sandbox failures), el operador vea el motivo real
    // instead of the generic "Claude Code process exited with code 1".
    const stderrLines: string[] = [];

    // Emit the same event AgentExecutor does so the 3D UI reuses its handlers
    events?.emit("agent:flow:run_started", {
      agent_id: agent.id,
      agent_name: agent.name,
      run_id: run.id,
      goal: goal.slice(0, 300),
      trigger_type: run.trigger_type,
    });
    service.logEvent({
      run_id: run.id,
      agent_id: agent.id,
      agent_name: agent.name,
      event_type: "run",
      event_subtype: "started",
      detail: `[claude-code] ${goal.slice(0, 180)}`,
      raw_data: { goal: goal.slice(0, 300), trigger_type: run.trigger_type, engine: "claude_code" },
    });

    // Handle returned by the sandbox driver. Cleaned up in the `finally`.
    let sandboxHandle: SandboxHandle | null = null;
    // Hoisted to execute()'s scope so the diagnostic probe in the catch can
    // reproduce the exact auth/cwd config the SDK used.
    let cwdResolved = "";
    let claudeBinResolved: string | undefined;
    let useOAuthResolved = false;
    let apiKeyResolved = "";
    let childEnvResolved: Record<string, string | undefined> = {};

    try {
      const { cwd, officeHomeFlow } = this.resolveCwd(agent, run, service);
      cwdResolved = cwd;
      const vars = this.parseVariables(agent);
      let systemPrompt = this.buildSystemPrompt(agent, goal, service);
      // When the agent inherited its office home (no per-agent cwd override),
      // tell it where it is and where to persist office knowledge.
      if (officeHomeFlow) {
        systemPrompt += "\n\n" + officeHomeGuidance(officeHomeFlow, cwd, resolveAgentLanguage(agent, this.configRef));
      }

      // Default auth: if the `claude` CLI is logged in we use OAuth (the
      // user's Max/Pro subscription), so they aren't billed per token while
      // already paying monthly. We only fall back to the API key when:
      //   - the CLI isn't installed / isn't logged in, or
      //   - the agent explicitly asks for `__prefer_api_key__ = true`
      //     (e.g. headless deploys with no CLI session).
      const apiKey = this.configRef?.webIntel?.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
      apiKeyResolved = apiKey;
      const claudeBin = this.findClaudeCodeBinary();
      claudeBinResolved = claudeBin;
      const useOAuth = vars.__prefer_api_key__ ? false : !!claudeBin;
      useOAuthResolved = useOAuth;

      if (!useOAuth && !apiKey) {
        throw new Error(
          "claude_code executor: no auth available. " +
          "Install the Claude Code CLI and log in (`claude login`) to use your subscription, " +
          "or set ANTHROPIC_API_KEY if you'd rather be billed per token.",
        );
      }

      const rawAllowed = this.parseJsonArray(agent.allowed_tools);
      const rawDenied = this.parseJsonArray(agent.denied_tools);

      // The Claude Code SDK exposes MCP tools as `mcp__<server>__<tool>`. The
      // kernel itself is registered (below) as MCP server "kernel" — so all
      // its tools (kernel_*, plus bridge-forwarded mcp_<bridge>_*) become
      // `mcp__kernel__<original-name>` on the SDK side. Built-in Claude tools
      // (Read, Bash, Edit, Write, Glob, Grep, WebFetch, WebSearch, Task,
      // ToolSearch, NotebookEdit, MultiEdit, SlashCommand, etc.) start with
      // an uppercase letter and pass through unchanged.
      const translateTool = (name: string): string => {
        if (!name) return name;
        // Already in SDK format → leave alone
        if (name.startsWith("mcp__")) return name;
        // Built-in Claude tools start with capital letter
        if (/^[A-Z]/.test(name)) return name;
        // Anything else (kernel_*, mcp_*) → kernel-prefixed MCP form
        return `mcp__kernel__${name}`;
      };
      const allowed = rawAllowed.map(translateTool);
      const denied = rawDenied.map(translateTool);

      // Env inherited by the subprocess. When going through OAuth we strip API
      // keys from the environment so the CLI falls back to ~/.claude.json creds.
      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "kernl/0.1",
        ...(vars.__env__ ?? {}),
      };
      childEnvResolved = childEnv;
      if (useOAuth) {
        childEnv.ANTHROPIC_API_KEY = undefined;
        childEnv.ANTHROPIC_AUTH_TOKEN = undefined;
        // When the kernel runs in a container the process user is usually not
        // the host user (e.g. `bun` with $HOME=/home/bun), but the OAuth creds
        // live in the `$HOST_HOME/.claude/` bind-mount. Without this override,
        // el CLI busca bajo `/home/bun/.claude/` y tira "Not logged in".
        if (process.env.HOST_HOME) {
          childEnv.HOME = process.env.HOST_HOME;
        }
      } else if (apiKey) {
        childEnv.ANTHROPIC_API_KEY = apiKey;
      }

      // Permission allow-list pura — con `permissionMode: 'dontAsk'`, cualquier
      // any tool/path not listed here is denied automatically. Read/Edit/Write/
      // Glob/Grep are scoped to the agent's cwd plus any extra declared paths.
      const cwdGlob = `${cwd.replace(/\/+$/, "")}/**`;
      // Always include the dirs holding (a) the kernel MCP Unix socket and
      // (b) the stdio bridge script — otherwise the SDK can't spawn the
      // bridge inside its bwrap and the bridge can't see the socket, so
      // every kernel_* tool call fails silently. Cheap, idempotent: the SDK
      // de-dupes additionalDirectories internally.
      const mcpSocketDir = resolveKernelMcpSocketPath().replace(/\/[^/]+$/, "") || "/";
      const bridgePath = process.env.KERNEL_MCP_BRIDGE
        ?? `${process.cwd()}/bin/mcp-stdio-bridge.ts`;
      const bridgeDir = bridgePath.replace(/\/[^/]+$/, "") || "/";
      const extraDirs = [
        mcpSocketDir,
        bridgeDir,
        ...(vars.__additional_directories__ ?? []),
      ];
      const extraAllows: string[] = [];
      for (const d of extraDirs) {
        const g = `${d.replace(/\/+$/, "")}/**`;
        extraAllows.push(`Read(${g})`, `Edit(${g})`, `Write(${g})`, `Grep(${g})`, `Glob(${g})`);
      }

      // Sandbox driver dispatch. Back-compat:
      //   - `__sandbox_driver__` is the new way to pick a backend.
      //   - `__container_sandbox__: true` without a driver → defaults to "docker".
      const driverSlug = this.resolveDriverSlug(vars);
      let executableToUse = claudeBin;
      const usingSandbox = !!driverSlug;

      // Refuse to run with `__sandbox__: false` unless the operator opted in.
      // Without sandbox + with Bash allowed = host RCE. Default policy: hard-deny.
      if (vars.__sandbox__ === false && !usingSandbox && process.env.KERNEL_ALLOW_UNSANDBOXED_AGENTS !== "1") {
        return {
          status: "failed",
          result: "",
          error: "agent declared __sandbox__: false but KERNEL_ALLOW_UNSANDBOXED_AGENTS is not set",
          steps_count: 0,
          tokens_used: 0,
        };
      }

      // Bash and WebFetch are known escape hatches when there is no sandbox/bwrap.
      // Without a sandbox they're only allowed when the agent asked for them
      // explicitly in `allowed_tools` (the signal that the operator accepts the
      // risk), or when KERNEL_ALLOW_UNSANDBOXED_BASH=1. This stops a freshly
      // created agent from inheriting Bash(*) by accident.
      const allowedSet = new Set(rawAllowed);
      const allowUnsandboxedBash = process.env.KERNEL_ALLOW_UNSANDBOXED_BASH === "1";
      const includeBash = usingSandbox || allowUnsandboxedBash || allowedSet.has("Bash");
      const includeWebFetch = usingSandbox || allowedSet.has("WebFetch");
      const permissionAllow = [
        `Read(${cwdGlob})`,
        `Edit(${cwdGlob})`,
        `Write(${cwdGlob})`,
        `Glob(${cwdGlob})`,
        `Grep(${cwdGlob})`,
        ...(includeBash ? ["Bash(*)"] : []),
        ...(includeWebFetch ? ["WebFetch(*)"] : []),
        "WebSearch(*)",
        "Task(*)",
        ...extraAllows,
        // Whitelist every MCP/kernel tool the agent listed in allowed_tools.
        // Without this, dontAsk mode silently denies them even though they
        // appear in `allowedTools` — `allowedTools` filters the catalog, but
        // `settings.permissions.allow` is the actual gate on each invocation.
        // Empty allowed_tools → fall back to a wildcard so kernel tools work
        // out of the box (matches the native executor's "no list = all
        // tools" semantics).
        ...(allowed.length > 0 ? allowed : ["mcp__kernel__*"]),
      ];

      if (driverSlug) {
        if (!this.sandboxRegistry) {
          throw new Error(
            `Agent "${agent.name}" requested sandbox driver "${driverSlug}" ` +
              `but SandboxDriverRegistry is not wired`,
          );
        }
        if (!this.sandboxRegistry.hasFactory(driverSlug)) {
          throw new Error(
            `Sandbox driver "${driverSlug}" not available. Installed: ` +
              `${this.sandboxRegistry.getAvailableSlugs().join(", ") || "(none)"}`,
          );
        }
        if (!this.sandboxRegistry.getDriver(driverSlug)) {
          // Registry has the factory but the driver isn't running — try to start it.
          const ok = await this.sandboxRegistry.startDriver(driverSlug);
          if (!ok) {
            throw new Error(
              `Sandbox driver "${driverSlug}" failed to start: ` +
                (this.sandboxRegistry.lastStartError ?? "unknown"),
            );
          }
        }

        // Minimal env — only what the claude CLI actually needs.
        const sandboxEnv: Record<string, string | undefined> = {
          CLAUDE_AGENT_SDK_CLIENT_APP: `kernl/0.1-sandboxed-${driverSlug}`,
          ...(vars.__env__ ?? {}),
        };
        if (!useOAuth && apiKey) {
          sandboxEnv.ANTHROPIC_API_KEY = apiKey;
        }

        const skillMounts: Array<{ name: string; hostPath: string }> = [];
        for (const name of vars.__skills__ ?? []) {
          const hostPath = this.resolveSkillHostPath(name, agent.id);
          if (hostPath) {
            skillMounts.push({ name, hostPath });
            log.info(`ClaudeCodeExecutor: skill "${name}" → ${hostPath}`);
          } else {
            log.warn(`ClaudeCodeExecutor: skill "${name}" no se encontró`);
          }
        }
        const pluginMounts: Array<{ name: string; hostPath: string }> = [];
        for (const ref of vars.__plugins__ ?? []) {
          const hit = this.resolvePluginHostPath(ref, agent.id);
          if (hit) {
            pluginMounts.push({ name: hit.name, hostPath: hit.path });
            log.info(`ClaudeCodeExecutor: plugin "${ref}" → ${hit.path} (${hit.scope})`);
          } else {
            log.warn(`ClaudeCodeExecutor: plugin "${ref}" no se encontró`);
          }
        }

        // Default network: join the kernel's compose network when present so
        // the agent container can reach the kernel via the `kernel` service
        // DNS for MCP HTTP. Operators can override per-agent with
        // `__sandbox_network__` or globally with $KERNEL_AGENT_DOCKER_NETWORK.
        const defaultNetwork = process.env.KERNEL_AGENT_DOCKER_NETWORK ?? "kernl_default";
        const network = vars.__no_network__
          ? "none"
          : (typeof vars.__sandbox_network__ === "string" && vars.__sandbox_network__
              ? vars.__sandbox_network__
              : defaultNetwork);
        const runOpts: SandboxRunOptions = {
          runId: run.id,
          workspace: {
            kernelPath: cwd,
            hostPath: hostPathFromKernel(cwd),
            snapshotId: vars.__sandbox_snapshot__,
          },
          env: sandboxEnv,
          network,
          image: vars.__sandbox_image__,
          skillMounts,
          pluginMounts,
        };

        sandboxHandle = await this.sandboxRegistry.prepareRun(driverSlug, runOpts);
        executableToUse = sandboxHandle.executablePath;
        log.info(
          `ClaudeCodeExecutor: sandbox driver "${driverSlug}" active for run ${run.id} → ${sandboxHandle.instanceId}`,
        );
      }

      // Plugins para pasar al SDK:
      //   - Sandboxed: point at the bind-mounts inside the container (/plugins/<name>).
      //   - Host: if the agent declared __plugins__, pass them with an absolute
      //     host path so they load even when the SDK is in isolate mode or the
      //     plugin sits in an agent-private workspace (which the SDK won't discover).
      //   - Host + no explicit __plugins__ + inherit mode: return undefined
      //     so the SDK uses its own `~/.claude/plugins/` auto-discovery.
      const sdkPlugins = (() => {
        const refs = vars.__plugins__ ?? [];
        if (refs.length === 0) return undefined;
        if (usingSandbox) {
          return refs
            .map(ref => {
              const hit = this.resolvePluginHostPath(ref, agent.id);
              if (!hit) return null;
              return { type: "local" as const, path: `/plugins/${hit.name}` };
            })
            .filter((x): x is { type: "local"; path: string } => x !== null);
        }
        return refs
          .map(ref => this.resolvePluginHostPath(ref, agent.id))
          .filter((h): h is { path: string; name: string; scope: "agent" | "user" } => h !== null)
          .map(h => ({ type: "local" as const, path: h.path }));
      })();

      const options: Options = {
        abortController,
        model: agent.model || "claude-opus-4-6",
        cwd,
        maxTurns: agent.max_iterations ?? 50,
        systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt },
        plugins: sdkPlugins && sdkPlugins.length > 0 ? sdkPlugins : undefined,
        // `dontAsk` → tools sin regla allow = DENEGADOS.
        // With an active sandbox driver we can be less strict — the
        // the sandbox is the real boundary, so bypassPermissions lets everything through.
        permissionMode: vars.__permission_mode__ ?? (usingSandbox ? "bypassPermissions" : "dontAsk"),
        allowDangerouslySkipPermissions: usingSandbox,
        allowedTools: allowed.length > 0 ? allowed : undefined,
        disallowedTools: denied.length > 0 ? denied : undefined,
        // Always inject the kernel itself as the "kernel" MCP server so all
        // kernel_* and mcp_* tools (the latter forwarded through the kernel's
        // own mcp-bridge) are reachable from inside the Claude Code SDK loop.
        // KERNEL_MCP_URL env override is for sandbox/remote deployments where
        // the kernel's HTTP API isn't on localhost:3087.
        mcpServers: {
          kernel: resolveKernelMcpServerConfig({
            agentId: agent.id,
            runId: run.id,
            depth: currentDepth,
            usingDockerSandbox: usingSandbox,
          }),
          ...sanitizeUserMcpServers(vars.__mcp_servers__),
        },
        additionalDirectories: extraDirs,
        // Control de herencia del user-scope (~/.claude.json + settings.json).
        // Default → [] (isolate). When the kernel runs in a container, the
        // plugins/MCPs declarados en `~/.claude/settings.json` del host suelen
        // fallar al arrancar (puertos en uso, tokens ausentes) y disparan el
        // guard "Uncaught exception loop detected" del CLI → exit 1 mudo.
        // We only inherit when the agent asks for it explicitly via
        // __settings_mode__: 'inherit'.
        settingSources: vars.__settings_mode__ === "inherit" ? ["user"] : [],
        persistSession: false,
        pathToClaudeCodeExecutable: executableToUse,
        env: childEnv,
        // Capture the CLI stderr — essential for diagnosing auth/billing failures
        // (e.g. "Credit balance is too low") that would otherwise stay hidden
        // behind the generic "process exited with code 1".
        stderr: (data) => {
          const trimmed = data.trim();
          if (!trimmed) return;
          stderrLines.push(trimmed);
          // Cap de 8KB — protege el log si el CLI escupe MB de errores.
          if (stderrLines.join("\n").length > 8_192) {
            stderrLines.splice(0, stderrLines.length / 2);
          }
        },
        // Rules only when there is NO driver — the sandbox already isolates.
        settings: usingSandbox
          ? undefined
          : { permissions: { allow: permissionAllow } },
        // OS-level bwrap sandbox — complements the rules when there is no driver.
        // With an active driver, bwrap is redundant.
        sandbox: (usingSandbox || vars.__sandbox__ === false) ? undefined : {
          enabled: true,
          failIfUnavailable: false,
          autoAllowBashIfSandboxed: true,
          network: vars.__no_network__
            ? { allowLocalBinding: false }
            : { allowLocalBinding: true, allowAllUnixSockets: true },
        },
      };

      const llmCaller = `claude_code:${agent.name}`;
      const llmModel = options.model ?? "claude-opus-4-6";
      const llmStartedAt = Date.now();
      let llmTurns = 0;
      let lastTurnAt = llmStartedAt;
      logLlmStart({
        slug: "claude_code",
        model: llmModel,
        // Goal is the only "message" the SDK sees up-front; tool count isn't
        // exposed by the SDK so we report 0 here (the CLI selects its own).
        messageCount: 1,
        toolCount: (allowed?.length ?? 0),
        caller: llmCaller,
        preview: goal,
      });

      const q = query({ prompt: goal, options });

      try {
        for await (const msg of q) {
          if (abortController.signal.aborted) break;
          // Each `assistant` message is one LLM turn — log it so the operator
          // can see the SDK loop progress at the same granularity as the
          // OpenAI-shaped providers' instrumentProvider wrapper.
          if (msg.type === "assistant") {
            llmTurns++;
            const now = Date.now();
            const turnMs = now - lastTurnAt;
            lastTurnAt = now;
            const blocks = (msg.message?.content ?? []) as Array<{ type: string }>;
            const toolCalls = blocks.filter((b) => b.type === "tool_use").length;
            logLlmEnd({
              slug: "claude_code",
              model: llmModel,
              durationMs: turnMs,
              toolCalls,
              caller: `${llmCaller}/turn-${llmTurns}`,
            });
          }
          const handled = this.handleMessage(msg, { agent, run, service, events, stepNumberRef: () => ++stepNumber });
          if (handled.tokensAdded) totalTokens += handled.tokensAdded;
          if (handled.finalText != null) finalText = handled.finalText;
          if (handled.errorText) errorMsg = handled.errorText;
        }
      } catch (err) {
        logLlmFail({
          slug: "claude_code",
          model: llmModel,
          durationMs: Date.now() - llmStartedAt,
          kind: "transient",
          message: err instanceof Error ? err.message : String(err),
          caller: llmCaller,
        });
        throw err;
      }

      // Loop closed cleanly — emit one summary line covering the whole run.
      logLlmEnd({
        slug: "claude_code",
        model: llmModel,
        durationMs: Date.now() - llmStartedAt,
        tokens: totalTokens,
        caller: `${llmCaller}/total · ${llmTurns} turns`,
        preview: finalText,
      });

      const status: ExecutionResult["status"] = errorMsg ? "failed" : "completed";

      // If we failed with "exited with code" (the SDK reports this through the
      // message pump rather than as a throw), run the diagnostic probe so the
      // operator sees the real cause (auth, billing, sandbox, etc).
      if (status === "failed" && errorMsg && /exited with code|terminated by signal/i.test(errorMsg)) {
        const stderrTail = stderrLines.length > 0 ? stderrLines.slice(-10).join("\n") : "";
        let probed = stderrTail
          || this.probeClaudeError(claudeBinResolved, useOAuthResolved, apiKeyResolved, cwdResolved, childEnvResolved);
        if (!probed && claudeBinResolved) {
          const authHint = useOAuthResolved
            ? "OAuth (Max/Pro sub). If the balance is low the CLI dies silently."
            : "API key. If the key is invalid or the balance is low the CLI dies silently.";
          probed = `subprocess murió sin output — ${authHint}\nReproducí a mano:\n  cd ${cwdResolved} && ${useOAuthResolved ? "" : "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY "}${claudeBinResolved} -p "ping"`;
        }
        if (probed) {
          errorMsg = `${errorMsg}\n${probed}`;
          log.error(`ClaudeCodeExecutor: agent "${agent.name}" failed: ${errorMsg}`);
        }
      }

      const execResult: ExecutionResult = {
        status,
        result: finalText,
        error: errorMsg,
        steps_count: stepNumber,
        tokens_used: totalTokens,
      };

      events?.emit("agent:flow:run_completed", {
        agent_id: agent.id,
        agent_name: agent.name,
        run_id: run.id,
        status: execResult.status,
        steps_count: execResult.steps_count,
        tokens_used: execResult.tokens_used,
        result_preview: execResult.result.slice(0, 200),
        error: execResult.error,
      });
      service.logEvent({
        run_id: run.id,
        agent_id: agent.id,
        agent_name: agent.name,
        event_type: "run",
        event_subtype: "completed",
        detail: `[claude-code] ${execResult.status}: ${execResult.steps_count} steps, ${execResult.tokens_used} tokens`,
        raw_data: {
          status: execResult.status,
          steps_count: execResult.steps_count,
          tokens_used: execResult.tokens_used,
          engine: "claude_code",
        },
        tokens_used: execResult.tokens_used,
      });

      if (run.trigger_type === "manual" && execResult.result) {
        service.addMemory(agent.id, "assistant", execResult.result.slice(0, 2000), run.id);
      }

      // Auto-eval — same closed-loop the native executor does, gated on
      // setNativeExecutor() + setEvalService() being wired during init.
      // tools_used is empty for now: the grader uses goal/result/error/steps
      // for its score; tools list is only a context hint.
      if (this.nativeExecutor && this.evalService?.isEnabled()) {
        try {
          await this.nativeExecutor.runAutoEvaluate(agent, run, goal, execResult, [], service, events);
        } catch (e) {
          log.warn(`claude_code auto-eval failed for run ${run.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return execResult;
    } catch (err) {
      // err may not be an Error instance (some SDK rejects come through as
      // pass strings or plain objects). We build a robust baseMsg.
      let baseMsg = "";
      if (err instanceof Error) baseMsg = err.message || err.toString();
      else if (typeof err === "string") baseMsg = err;
      else if (err && typeof err === "object") baseMsg = JSON.stringify(err);
      else baseMsg = String(err);
      if (!baseMsg) baseMsg = "Claude Code SDK threw without a message";

      // If the stderr callback managed to collect something, use it. Otherwise
      // we run ONE diagnostic probe reproducing the same config and
      // capturing its raw stderr. That surfaces messages like
      // "Credit balance is too low" que el SDK come.
      let extra = stderrLines.length > 0 ? stderrLines.slice(-10).join("\n") : "";
      if (!extra) {
        extra = this.probeClaudeError(claudeBinResolved, useOAuthResolved, apiKeyResolved, cwdResolved, childEnvResolved);
      }
      // Si el subprocess murió mudo (caso típico: auth/billing/sandbox issues
      // which the CLI only reports in interactive mode), hand the operator
      // the exact command to run to see the real reason.
      if (!extra && claudeBinResolved && /exited with code|terminated by signal/i.test(baseMsg)) {
        const authHint = useOAuthResolved
          ? "OAuth (Max/Pro sub). If the balance is low the CLI dies silently."
          : "API key. If the key is invalid or the balance is low the CLI dies silently.";
        extra = `subprocess died with no output — ${authHint}\nReproduce it by hand to see why:\n  cd ${cwdResolved} && ${useOAuthResolved ? "" : "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY "}${claudeBinResolved} -p "ping"`;
      }
      const msg = extra ? `${baseMsg}\n${extra}` : baseMsg;
      log.error(`ClaudeCodeExecutor: agent "${agent.name}" failed: ${msg}`);

      stepNumber++;
      service.addStep({
        run_id: run.id,
        step_number: stepNumber,
        type: "error",
        content: msg,
      });
      events?.emit("agent:flow:step", {
        agent_id: agent.id,
        agent_name: agent.name,
        run_id: run.id,
        step_number: stepNumber,
        type: "error",
        content_preview: msg.slice(0, 400),
      });
      events?.emit("agent:flow:run_completed", {
        agent_id: agent.id,
        agent_name: agent.name,
        run_id: run.id,
        status: "failed",
        steps_count: stepNumber,
        tokens_used: totalTokens,
        result_preview: finalText.slice(0, 200),
        error: msg,
      });
      service.logEvent({
        run_id: run.id,
        agent_id: agent.id,
        agent_name: agent.name,
        event_type: "run",
        event_subtype: "completed",
        detail: `[claude-code] failed: ${msg.slice(0, 180)}`,
        raw_data: { status: "failed", steps_count: stepNumber, tokens_used: totalTokens, engine: "claude_code" },
        tokens_used: totalTokens,
      });

      const failedExecResult: ExecutionResult = {
        status: "failed",
        result: finalText,
        error: msg,
        steps_count: stepNumber,
        tokens_used: totalTokens,
      };

      // Auto-eval the failure too — extracting an "AVOID" learning from a
      // failed run is exactly the signal we want to capture for next time.
      if (this.nativeExecutor && this.evalService?.isEnabled()) {
        try {
          await this.nativeExecutor.runAutoEvaluate(agent, run, goal, failedExecResult, [], service, events);
        } catch (e) {
          log.warn(`claude_code auto-eval (failed-path) failed for run ${run.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return failedExecResult;
    } finally {
      this.activeRuns.delete(run.id);
      if (sandboxHandle && this.sandboxRegistry) {
        await this.sandboxRegistry.cleanup(sandboxHandle).catch((err) => {
          log.warn(`ClaudeCodeExecutor: sandbox cleanup failed: ${String(err)}`);
        });
      }
    }
  }

  // ── Message dispatch ───────────────────────────────

  private handleMessage(
    msg: SDKMessage,
    ctx: {
      agent: Agent;
      run: AgentRun;
      service: AgentService;
      events?: EventBus;
      stepNumberRef: () => number;
    },
  ): { tokensAdded?: number; finalText?: string | null; errorText?: string } {
    const { agent, run, service, events, stepNumberRef } = ctx;

    if (msg.type === "assistant") {
      const content = msg.message.content ?? [];
      for (const block of content) {
        if (block.type === "text") {
          const text = block.text ?? "";
          if (!text.trim()) continue;
          const stepNum = stepNumberRef();
          service.addStep({ run_id: run.id, step_number: stepNum, type: "thought", content: text });
          events?.emit("agent:flow:step", {
            agent_id: agent.id,
            agent_name: agent.name,
            run_id: run.id,
            step_number: stepNum,
            type: "thought",
            content_preview: text.slice(0, 2000),
          });
          service.logEvent({
            run_id: run.id,
            agent_id: agent.id,
            agent_name: agent.name,
            event_type: "step",
            event_subtype: "thought",
            detail: text.slice(0, 200),
            raw_data: { step_number: stepNum },
          });
        } else if (block.type === "tool_use") {
          const toolName = block.name ?? "";
          const toolInput = (block.input as Record<string, unknown>) ?? {};
          const stepNum = stepNumberRef();
          service.addStep({
            run_id: run.id,
            step_number: stepNum,
            type: "tool_call",
            tool_name: toolName,
            tool_input: toolInput,
          });
          events?.emit("agent:flow:step", {
            agent_id: agent.id,
            agent_name: agent.name,
            run_id: run.id,
            step_number: stepNum,
            type: "tool_call",
            tool_name: toolName,
            content_preview: JSON.stringify(toolInput).slice(0, 800),
          });
          service.logEvent({
            run_id: run.id,
            agent_id: agent.id,
            agent_name: agent.name,
            event_type: "step",
            event_subtype: "tool_call",
            detail: toolName,
            raw_data: { step_number: stepNum, tool_name: toolName, tool_input: toolInput },
          });
        }
      }
      return {};
    }

    if (msg.type === "user") {
      const content = msg.message.content;
      if (!Array.isArray(content)) return {};
      for (const block of content) {
        if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result") {
          const toolResultText = this.extractToolResultText(block);
          const isError = Boolean((block as { is_error?: boolean }).is_error);
          const toolName = this.resolveToolNameFromResult(block, ctx);
          const stepNum = stepNumberRef();
          service.addStep({
            run_id: run.id,
            step_number: stepNum,
            type: "tool_result",
            tool_name: toolName,
            tool_output: toolResultText,
          });
          events?.emit("agent:flow:step", {
            agent_id: agent.id,
            agent_name: agent.name,
            run_id: run.id,
            step_number: stepNum,
            type: "tool_result",
            tool_name: toolName,
            content_preview: toolResultText.slice(0, 2000),
          });
          service.logEvent({
            run_id: run.id,
            agent_id: agent.id,
            agent_name: agent.name,
            event_type: "step",
            event_subtype: "tool_result",
            detail: `${toolName}: ${toolResultText.slice(0, 150)}`,
            raw_data: { step_number: stepNum, tool_name: toolName, is_error: isError },
          });
        }
      }
      return {};
    }

    if (msg.type === "result") {
      const tokens = msg.usage
        ? (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0)
        : 0;
      if (msg.subtype === "success") {
        const finalTxt = msg.result ?? "";
        if (finalTxt.trim()) {
          const stepNum = stepNumberRef();
          service.addStep({ run_id: run.id, step_number: stepNum, type: "final", content: finalTxt, tokens });
          events?.emit("agent:flow:step", {
            agent_id: agent.id,
            agent_name: agent.name,
            run_id: run.id,
            step_number: stepNum,
            type: "final",
            content_preview: finalTxt.slice(0, 2000),
          });
          service.logEvent({
            run_id: run.id,
            agent_id: agent.id,
            agent_name: agent.name,
            event_type: "step",
            event_subtype: "final",
            detail: finalTxt.slice(0, 200),
            raw_data: { step_number: stepNum },
            tokens_used: tokens,
          });
        }
        return { tokensAdded: tokens, finalText: finalTxt };
      }
      // Error subtypes: error_during_execution | error_max_turns | error_max_budget_usd | ...
      const errText = msg.errors?.join("; ") || msg.subtype;
      return { tokensAdded: tokens, errorText: errText };
    }

    return {};
  }

  // ── Helpers ─────────────────────────────────────────

  /**
   * Detect a locally installed `claude` CLI (gnu-compatible). Cached
   * because the scan runs on every run. Order:
   *   $CLAUDE_CODE_PATH → `which claude` → $HOST_CLAUDE_CLI (bind-mount desde
   *   the host when the kernel runs in a container) → typical locations.
   * Returns undefined when there is none.
   */
  private findClaudeCodeBinary(): string | undefined {
    if (this.cachedClaudeBin !== undefined) return this.cachedClaudeBin ?? undefined;

    const override = process.env.CLAUDE_CODE_PATH;
    if (override && existsSync(override)) {
      this.cachedClaudeBin = override;
      return override;
    }

    try {
      const which = spawnSync("which", ["claude"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      const path = (which.stdout ?? "").trim();
      if (which.status === 0 && path && existsSync(path)) {
        this.cachedClaudeBin = path;
        return path;
      }
    } catch { /* not on PATH */ }

    // When the kernel runs in a container (docker-compose sets HOST_CLAUDE_CLI),
    // the host CLI is bind-mounted but not on PATH. Preferring it over the
    // SDK's embedded binary guarantees OAuth finds the same creds the user
    // logged in with via `claude login` on the host.
    const hostCli = process.env.HOST_CLAUDE_CLI;
    if (hostCli && existsSync(hostCli)) {
      this.cachedClaudeBin = hostCli;
      return hostCli;
    }

    const candidates = [
      `${process.env.HOME ?? ""}/.local/bin/claude`,
      "/usr/local/bin/claude",
      "/usr/bin/claude",
      // Fall back to the gnu binary the SDK embeds — useful when Bun runs on
      // glibc but detects musl and points at the wrong package by default.
      resolve(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"),
      "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        this.cachedClaudeBin = c;
        return c;
      }
    }

    this.cachedClaudeBin = null;
    return undefined;
  }

  private resolveCwd(
    agent: Agent,
    run: AgentRun,
    service?: AgentService,
  ): { cwd: string; officeHomeFlow: AgentFlow | null } {
    // Prioridad:
    //   1. __cwd_path__ in the agent's variables (absolute path outside the kernel)
    //   2. workspace in the run's trigger_payload (per-run override)
    //   3. __workspace__ in the agent's variables (agent default)
    //   4. the office home (inherited) — service.resolveFlowHome(flow_id)
    //   5. fallback: data/workspaces/agent-<id>/
    const vars = this.parseVariables(agent);
    if (vars.__cwd_path__) {
      const p = vars.__cwd_path__;
      if (p.startsWith("/") && existsSync(p)) {
        return { cwd: p, officeHomeFlow: null };
      }
      log.warn(
        `ClaudeCodeExecutor: __cwd_path__="${p}" inválido (no absoluto o no existe) — cae a workspace fallback`,
      );
    }

    let subdir = `agent-${agent.id}`;
    let isCustom = false;
    try {
      const payload = JSON.parse(run.trigger_payload || "{}");
      if (typeof payload?.workspace === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(payload.workspace)) {
        subdir = payload.workspace;
        isCustom = true;
      } else if (vars.__workspace__ && /^[A-Za-z0-9_-]{1,64}$/.test(vars.__workspace__)) {
        subdir = vars.__workspace__;
        isCustom = true;
      }
    } catch { /* ignore malformed payload */ }

    // No per-agent / per-run override → inherit the office home (step 4). The
    // home is a kernel workspace by default or a host git repo once promoted.
    // We seed the folder convention here (lazy, idempotent) so it only touches
    // disk at real run-time, never during flow creation or tests.
    if (!isCustom && service && agent.flow_id) {
      try {
        const home = service.resolveFlowHome(agent.flow_id);
        if (home && (home.kind !== "git" || existsSync(home.path))) {
          mkdirSync(home.path, { recursive: true });
          try { seedOfficeHome(home.path, home.flow); } catch { /* non-fatal */ }
          return { cwd: home.path, officeHomeFlow: home.flow };
        }
      } catch (err) {
        log.warn(`ClaudeCodeExecutor: resolveFlowHome failed for flow ${agent.flow_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const root = resolve(process.cwd(), "data", "workspaces", subdir);
    mkdirSync(root, { recursive: true });

    // Auto-register the workspace in the registry so it shows up in the
    // dashboard's "Workspaces" tab. We use the subdir as the id (stable,
    // human-readable, matches the on-disk path). Custom workspaces only; the
    // default `agent-<id>` stays implicit and isn't listed there.
    if (isCustom && this.wsService) {
      try {
        if (!this.wsService.get(subdir)) {
          this.wsService.create({
            id: subdir,
            name: subdir,
            owner_flow_id: agent.flow_id || "",
            description: `Auto-registered by the claude_code executor (agent: ${agent.name})`,
          });
          log.info(`ClaudeCodeExecutor: registered workspace "${subdir}" for flow ${agent.flow_id}`);
        }
      } catch (err) {
        log.warn(`ClaudeCodeExecutor: no se pudo registrar workspace "${subdir}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { cwd: root, officeHomeFlow: null };
  }

  /**
   * Diagnostic probe: when the SDK dies with "exited with code 1" and leaves
   * us no stderr, reproduce the same auth + cwd combination with a minimal
   * prompt and capture whatever the CLI writes to stderr. A short timeout
   * (8s) keeps this from adding much latency to the failure path.
   *
   * Surfaces common errors the SDK swallows, in particular:
   *   - "Credit balance is too low" (cuenta sin créditos)
   *   - "Invalid API key" / "Not logged in"
   *   - errores de sandbox o de mounts
   */
  private probeClaudeError(
    claudeBin: string | undefined,
    useOAuth: boolean,
    apiKey: string,
    cwd: string,
    parentEnv: Record<string, string | undefined>,
  ): string {
    if (!claudeBin || !existsSync(claudeBin)) {
      log.warn(`probeClaudeError: skipping — bin ${claudeBin} not found`);
      return "";
    }
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(parentEnv)) {
        if (typeof v === "string") env[k] = v;
      }
      if (useOAuth) {
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;
      } else if (apiKey) {
        env.ANTHROPIC_API_KEY = apiKey;
      }
      const result = spawnSync(claudeBin, ["-p", "ping"], {
        cwd: existsSync(cwd) ? cwd : process.cwd(),
        env,
        timeout: 8_000,
        encoding: "utf-8",
        input: "", // close stdin — without this the CLI can sit waiting for input
      });
      const stderr = (result.stderr || "").trim();
      const stdout = (result.stdout || "").trim();
      // The CLI sometimes writes the error to stdout (e.g. "Credit balance is too low").
      const out = stderr || stdout;
      if (!out) return "";
      // Capped at 600 chars — enough for the cause, without filling the agent_runs table.
      return out.length > 600 ? out.slice(0, 600) + "…" : out;
    } catch {
      return "";
    }
  }

  private buildSystemPrompt(agent: Agent, goal: string, service?: AgentService): string {
    const lang = resolveAgentLanguage(agent, this.configRef);
    const base = resolveAgentSystemPrompt(agent, lang);
    const parts: string[] = [];
    if (base) parts.push(base);
    parts.push(promptTodayDate(lang, new Date().toISOString().slice(0, 10)));
    parts.push(promptClaudeCodeWorkInstructions(lang));

    // Inject learnings ranked by relevance to current goal — same closed-loop
    // the native executor uses (executor.ts:576). Without this, claude_code
    // agents fly blind: auto-eval may grade their runs but they never see the
    // accumulated lessons on the next run.
    if (service) {
      try {
        const learnings = service.getRelevantLearnings(agent.id, goal, 15);
        const block = promptLearningsBlock(lang, learnings);
        if (block) parts.push(block);
      } catch { /* learnings table missing in tests / fresh DB — non-fatal */ }
    }

    // Recency-biased language reinforcement — claude_code preset has its own
    // English-heavy system text, so we close with an explicit STYLE rule.
    parts.push(promptStyleDirective(lang));

    return parts.join("\n\n");
  }

  private parseVariables(agent: Agent): AgentVariablesMcp {
    let raw: Record<string, unknown> = {};
    try {
      const v = JSON.parse(agent.variables || "{}");
      if (typeof v === "object" && v !== null) raw = v as Record<string, unknown>;
    } catch { /* invalid json */ }

    // `variables` is a Record<string,string> coming from the dashboard form, so
    // campos estructurados (__env__, __mcp_servers__, __additional_directories__)
    // arrive JSON-encoded and have to be reparsed.
    const unpack = <T>(key: string): T | undefined => {
      const v = raw[key];
      if (v == null) return undefined;
      if (typeof v === "string") {
        try { return JSON.parse(v) as T; } catch { return undefined; }
      }
      return v as T;
    };
    const boolVar = (key: string, defaultVal: boolean): boolean => {
      const v = raw[key];
      if (v === undefined) return defaultVal;
      return v === true || v === "true";
    };
    return {
      __prefer_oauth__: boolVar("__prefer_oauth__", false),
      __prefer_api_key__: boolVar("__prefer_api_key__", false),
      __sandbox__: boolVar("__sandbox__", true),
      __container_sandbox__: boolVar("__container_sandbox__", false),
      __sandbox_driver__: typeof raw.__sandbox_driver__ === "string" ? raw.__sandbox_driver__ : undefined,
      __sandbox_snapshot__: typeof raw.__sandbox_snapshot__ === "string" ? raw.__sandbox_snapshot__ : undefined,
      __sandbox_config__: unpack<Record<string, unknown>>("__sandbox_config__"),
      __no_network__: boolVar("__no_network__", false),
      __sandbox_image__: typeof raw.__sandbox_image__ === "string" ? raw.__sandbox_image__ : undefined,
      __permission_mode__: typeof raw.__permission_mode__ === "string"
        ? (raw.__permission_mode__ as PermissionMode)
        : undefined,
      __env__: unpack<Record<string, string>>("__env__"),
      __additional_directories__: unpack<string[]>("__additional_directories__"),
      __mcp_servers__: unpack<Record<string, McpServerConfig>>("__mcp_servers__"),
      __skills__: unpack<string[]>("__skills__"),
      __plugins__: unpack<string[]>("__plugins__"),
      __workspace__: typeof raw.__workspace__ === "string" ? raw.__workspace__ : undefined,
      __cwd_path__: typeof raw.__cwd_path__ === "string" ? raw.__cwd_path__ : undefined,
    };
  }

  /**
   * Pick a sandbox driver slug from agent variables. Prefers the explicit
   * `__sandbox_driver__`; falls back to the legacy `__container_sandbox__`
   * boolean (which defaults to "docker"). Returns `null` when no sandbox
   * is requested.
   */
  private resolveDriverSlug(vars: AgentVariablesMcp): string | null {
    if (vars.__sandbox_driver__ && vars.__sandbox_driver__.trim() !== "") {
      return vars.__sandbox_driver__;
    }
    if (vars.__container_sandbox__) return "docker";
    // Instance-wide default. Without it, an agent only ran sandboxed if it
    // thought to ask for a driver by name — and an agent created by another
    // agent never does. It asked for `__sandbox__: false` instead, hit the
    // hard-deny, and the operator's only obvious way out was to switch the
    // deny off globally. Setting a default here means "sandboxed" is what you
    // get for free and unsandboxed stays the deliberate exception.
    const fallback = (process.env.AGENTS_DEFAULT_SANDBOX_DRIVER ?? "").trim();
    return fallback !== "" ? fallback : null;
  }

  /**
   * Resolve a plugin name to its path on the host. Accepts:
   *   - "<marketplace>/<plugin>"  (ej. "claude-plugins-official/frontend-design")
   *   - "<plugin>"                 (searched across every marketplace)
   *
   * Lookup order:
   *   1. data/agents/<agentId>/plugins/<name>/  (per-agent private)
   *   2. ~/.claude/plugins/marketplaces/<mk>/plugins/<name>/ (user-scope shared)
   *
   * Returns scope='agent' when resolved in the private workspace, 'user' when
   * in user-scope. Callers use this to decide whether Options.plugins must be
   * passed explicitly (private plugins aren't auto-discovered by the SDK).
   */
  private resolvePluginHostPath(
    pluginRef: string,
    agentId?: string,
  ): { path: string; name: string; scope: "agent" | "user" } | null {
    let marketplace: string | undefined;
    let pluginName: string;
    if (pluginRef.includes("/")) {
      const [mp, pl] = pluginRef.split("/", 2);
      marketplace = mp;
      pluginName = pl;
    } else {
      pluginName = pluginRef;
    }

    // Reject any component that could escape the plugin tree (path traversal / shell metas).
    // Plugins / marketplaces are short identifiers, never paths.
    if (!isSafeIdentifier(pluginName) || (marketplace !== undefined && !isSafeIdentifier(marketplace))) {
      return null;
    }

    // 1) Agent-private
    if (agentId && isSafeIdentifier(agentId)) {
      const privatePath = resolve(process.cwd(), "data/agents", agentId, "plugins", pluginName);
      if (existsSync(privatePath)) {
        return { path: privatePath, name: pluginName, scope: "agent" };
      }
    }

    // 2) User-scope marketplaces
    const home = process.env.HOST_HOME ?? homedir();
    const marketplacesDir = resolve(home, ".claude", "plugins", "marketplaces");
    if (!existsSync(marketplacesDir)) return null;

    try {
      const mps = marketplace
        ? [marketplace]
        : readdirSync(marketplacesDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && isSafeIdentifier(d.name))
            .map((d) => d.name);
      for (const mp of mps) {
        if (!isSafeIdentifier(mp)) continue;
        const candidatePath = resolve(marketplacesDir, mp, "plugins", pluginName);
        if (existsSync(candidatePath)) return { path: candidatePath, name: pluginName, scope: "user" };
      }
    } catch { /* ignore — no marketplaces dir or unreadable */ }
    return null;
  }

  /**
   * Resolve a skill name to its host path. Lookup order:
   *   1. data/agents/<agentId>/skills/<name>/  (per-agent private)
   *   2. ~/.claude/skills/<name>/              (user-level)
   *   3. ~/.claude/plugins/marketplaces/.../plugins/x/skills/<name>/ (plugin)
   * Returns null if not found.
   */
  private resolveSkillHostPath(skillName: string, agentId?: string): string | null {
    // skillName is interpolated into filesystem paths and previously into a shell command.
    // Reject anything that isn't a plain identifier — no slashes, dots, or shell metas.
    if (!isSafeIdentifier(skillName)) return null;

    // 1) Agent-private
    if (agentId && isSafeIdentifier(agentId)) {
      const privatePath = resolve(process.cwd(), "data/agents", agentId, "skills", skillName);
      if (existsSync(privatePath)) return privatePath;
    }

    const home = process.env.HOST_HOME ?? homedir();
    // 2) user-level
    const userPath = resolve(home, ".claude", "skills", skillName);
    if (existsSync(userPath)) return userPath;
    // 3) plugin-provided: scan ~/.claude/plugins/marketplaces/*/plugins/*/skills/<name>
    //    (native walk, no shell — previously used `find` with shell interpolation).
    const marketplacesRoot = resolve(home, ".claude", "plugins", "marketplaces");
    try {
      if (!existsSync(marketplacesRoot)) return null;
      for (const mp of readdirSync(marketplacesRoot, { withFileTypes: true })) {
        if (!mp.isDirectory() || !isSafeIdentifier(mp.name)) continue;
        const pluginsRoot = resolve(marketplacesRoot, mp.name, "plugins");
        if (!existsSync(pluginsRoot)) continue;
        for (const plugin of readdirSync(pluginsRoot, { withFileTypes: true })) {
          if (!plugin.isDirectory() || !isSafeIdentifier(plugin.name)) continue;
          const skillPath = resolve(pluginsRoot, plugin.name, "skills", skillName);
          try {
            if (existsSync(skillPath) && statSync(skillPath).isDirectory()) {
              return skillPath;
            }
          } catch { /* ignore unreadable entry */ }
        }
      }
    } catch { /* no marketplaces tree, no skill */ }
    return null;
  }

  private parseJsonArray(raw: string): string[] {
    try {
      let parsed = JSON.parse(raw || "[]");
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private extractToolResultText(block: unknown): string {
    if (typeof block !== "object" || block === null) return "";
    const b = block as { content?: unknown };
    if (typeof b.content === "string") return b.content;
    if (Array.isArray(b.content)) {
      return b.content
        .map((c) => {
          if (typeof c === "string") return c;
          if (typeof c === "object" && c !== null && "text" in c && typeof (c as { text: unknown }).text === "string") {
            return (c as { text: string }).text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  /**
   * The tool_result block only carries `tool_use_id`, not the name. We resolve it
   * by querying the most recent tool_call step just persisted for this run.
   * Not pretty, but it avoids keeping a map in memory.
   */
  private resolveToolNameFromResult(
    block: unknown,
    ctx: { run: AgentRun; service: AgentService },
  ): string {
    const id = typeof block === "object" && block !== null && "tool_use_id" in block
      ? String((block as { tool_use_id: unknown }).tool_use_id ?? "")
      : "";
    const steps = ctx.service.getSteps(ctx.run.id);
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.type === "tool_call") {
        try {
          const inp = JSON.parse(s.tool_input || "{}");
          // the SDK doesn't store the id in tool_input, so we return the last unmatched tool_call.
          void inp;
        } catch { /* ignore */ }
        return s.tool_name;
      }
    }
    return id || "unknown";
  }
}

/**
 * Translate a path inside the kernel container (e.g. `/app/data/...`) to its
 * equivalent on the Docker host. Needed for Docker-in-Docker bind-mounts and
 * for any driver that ultimately hands paths to the host daemon.
 */
function hostPathFromKernel(p: string): string {
  const hostRoot = process.env.HOST_KERNEL_ROOT;
  if (hostRoot && p.startsWith("/app/")) {
    return p.replace(/^\/app/, hostRoot);
  }
  return p;
}


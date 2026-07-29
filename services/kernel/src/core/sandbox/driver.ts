/**
 * Unified sandbox driver interface.
 *
 * Every sandbox backend (Docker, CubeSandbox, Firecracker, bubblewrap, …)
 * implements this contract and registers itself with SandboxDriverRegistry.
 * The `claude_code` executor (and eventually other executors) asks the
 * registry for a driver by slug, calls `prepareRun()` to get an executable
 * wrapper that launches the agent CLI inside the sandbox, and calls
 * `cleanup()` once the run finishes.
 *
 * Drivers can ship as built-in factories (registered at bootstrap) or as
 * installable extensions with `type: "sandbox-driver"` — both converge on
 * the same registry API.
 */

import type { ConfigField } from "../notify/provider.js";

export type { ConfigField };

// ── Capabilities ──────────────────────────────────────────────────────

/**
 * Static capability metadata — the executor consults these to decide
 * whether a driver fits a given run (e.g. "this run needs snapshots").
 */
export interface SandboxCapabilities {
  /** Supports CoW snapshot cloning of a pre-built template. */
  snapshots: boolean;
  /** Network isolation granularity. */
  networkIsolation: "none" | "bridge" | "egress-policy";
  /** Approximate cold-start (ms) for a fresh instance. */
  coldStartMs: number;
  /** How the driver exposes workspace directories to the sandbox. */
  workspaceModel: "bind-mount" | "snapshot-clone" | "virtiofs";
  /** Can execute arbitrary shell commands inside the sandbox. */
  exec: boolean;
  /** Driver can enforce resource limits (cpu / memory / pids). */
  resourceLimits: boolean;
}

// ── Runtime input / output ────────────────────────────────────────────

export interface NamedMount {
  /** Logical name (e.g. skill slug, plugin slug). */
  name: string;
  /** Host path (driver resolves inside the sandbox). */
  hostPath: string;
}

export interface ExtraMount {
  host: string;
  container: string;
  readonly?: boolean;
}

export interface SandboxRunOptions {
  /** Correlating run id — used for instance names and telemetry. */
  runId: string;
  workspace: {
    /** Path inside the kernel container (`/app/data/...`). */
    kernelPath: string;
    /** Path on the real host (for drivers that bind-mount from outside). */
    hostPath: string;
    /** Optional snapshot reference — drivers that support it clone this. */
    snapshotId?: string;
  };
  /** Env vars passed to the sandboxed process. Undefined values are dropped. */
  env: Record<string, string | undefined>;
  /** Network mode. Drivers that don't support `egress-policy` treat it as bridge.
   *  String values other than `"bridge"`/`"none"` are passed through as named
   *  networks (used to join the kernel's compose network so agent runs can
   *  reach the MCP HTTP endpoint via service DNS). */
  network?:
    | "bridge"
    | "none"
    | string
    | { mode: "egress-policy"; allowHosts: string[] };
  /** Skill directories to mount read-only at predictable paths. */
  skillMounts?: NamedMount[];
  /** Plugin directories to mount read-only. */
  pluginMounts?: NamedMount[];
  /** Extra arbitrary mounts — escape hatch for advanced use. */
  extraMounts?: ExtraMount[];
  /** Resource caps — drivers without support ignore silently. */
  resources?: {
    memoryMb?: number;
    cpus?: number;
    pidsLimit?: number;
  };
  /** Base image / template hint. Drivers decide what to do with it. */
  image?: string;
  /**
   * Host-resident files that MUST be available inside the sandbox
   * (usually the agent CLI binary and its auth credentials).
   */
  hostBinaries?: {
    claudeCli?: string;
    claudeJson?: string;
    claudeCreds?: string;
  };
  /** Command to run inside the sandbox. Defaults to `claude "$@"`. */
  entryCommand?: string;
}

export interface SandboxHandle {
  /**
   * Absolute path to a spawnable executable the caller will pass to the
   * Claude Agent SDK as `pathToClaudeCodeExecutable`. Whether it runs
   * `docker run …` or `cubemastercli sandbox …` is the driver's secret.
   */
  executablePath: string;
  /** Opaque instance id — container name / sandbox id / whatever. */
  instanceId: string;
  /** Driver slug (set by the driver for telemetry). */
  driver: string;
  /** ISO timestamp when prepareRun() completed. */
  startedAt: string;
  /** Optional back-reference to the snapshot the instance was cloned from. */
  snapshotBase?: string;
}

// ── Status ────────────────────────────────────────────────────────────

export interface SandboxDriverStatus {
  slug: string;
  name: string;
  ready: boolean;
  /** Slugs of built-in vs installed-via-extension drivers. */
  source: "builtin" | "extension";
  capabilities: SandboxCapabilities;
  /** Last healthcheck error, if any. */
  error?: string;
  /** Optional diagnostic info (ex. daemon version, API URL). */
  info?: Record<string, unknown>;
}

// ── Driver contract ───────────────────────────────────────────────────

export interface SandboxDriver {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: SandboxCapabilities;

  /** Config fields for the dashboard form. */
  getConfigSchema(): ConfigField[];
  /** Validate user-supplied config. */
  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] };
  /** Apply config. Called before start(). */
  configure(config: Record<string, unknown>): void;

  /** Verify the backend is reachable (docker ping / cube API ping / …). */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Whether the driver is ready to prepareRun(). */
  isReady(): boolean;
  getStatus(): SandboxDriverStatus;

  /** Build whatever artifacts are needed and return a handle. */
  prepareRun(opts: SandboxRunOptions): Promise<SandboxHandle>;
  /** Tear down per-run state (scripts, snapshots, tmpfiles). */
  cleanup(handle: SandboxHandle): Promise<void>;
}

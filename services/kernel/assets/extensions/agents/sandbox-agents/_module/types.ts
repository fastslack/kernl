import { z } from "zod";

// ── Manifest ──────────────────────────────────────────────────────────────────

/** Zod schema for manifest.json found in ./agents/<name>/ */
export const AgentManifestSchema = z.object({
  /** Unique slug — must match the directory name */
  name: z.string().regex(/^[a-z0-9-]+$/, "Must be lowercase alphanumeric with dashes"),
  /** Human-readable display name */
  displayName: z.string().min(1),
  /** Short description of what the agent does */
  description: z.string().min(1),
  /** Semver string */
  version: z.string().default("0.1.0"),
  /** Entry point relative to the agent directory (default: index.ts) */
  entry: z.string().default("index.ts"),
  /**
   * List of kernel tool names this agent is allowed to call.
   * Use "*" to allow all tools (discouraged — prefer explicit list).
   */
  permissions: z.array(z.string()).default([]),
  /**
   * Kernel tools exposed as MCP tools BY this agent (i.e., the agent
   * contributes new tools to the kernel that call into the subprocess).
   * Each item becomes a kernel_sandboxagent_<name>_<toolName> tool.
   */
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.unknown()).default({}),
  })).default([]),
  /** Max ms the agent process may run per request before being killed */
  timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
  /** Whether to auto-start agent on kernel boot (default: true) */
  autoStart: z.boolean().default(true),
  /** Custom env vars to inject into the subprocess (non-secret) */
  env: z.record(z.string()).default({}),
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

// ── JSON-RPC protocol (agent ↔ kernel) ───────────────────────────────────────

/** Kernel → Agent: invoke a handler the agent registered */
export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;       // tool name (as declared in manifest.tools[].name)
  params: unknown;
}

/** Agent → Kernel: call a kernel tool */
export interface RpcToolCall {
  jsonrpc: "2.0";
  id: number;
  method: "kernel.call";
  params: {
    tool: string;       // kernel tool name (must be in permissions)
    args: unknown;
  };
}

/** Generic JSON-RPC success response */
export interface RpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

/** Generic JSON-RPC error response */
export interface RpcError {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type RpcMessage = RpcRequest | RpcToolCall | RpcSuccess | RpcError;

/** Resolved agent descriptor (manifest + resolved path) */
export interface AgentDescriptor {
  manifest: AgentManifest;
  /** Absolute path to agent directory */
  dir: string;
  /** Absolute path to entry point */
  entryPath: string;
}

// ── Sandbox runtime state ─────────────────────────────────────────────────────

export type SandboxStatus = "stopped" | "starting" | "ready" | "error";

export interface SandboxState {
  name: string;
  status: SandboxStatus;
  pid: number | null;
  startedAt: string | null;
  restarts: number;
  lastError: string | null;
}

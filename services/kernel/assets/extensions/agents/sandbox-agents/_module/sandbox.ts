import { log } from "../../../../../src/core/logger.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import type {
  AgentDescriptor,
  AgentManifest,
  RpcRequest,
  RpcSuccess,
  RpcError,
  RpcToolCall,
  SandboxState,
  SandboxStatus,
} from "./types.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";

// Bun.spawn with stdio:"pipe" guarantees FileSink for stdin and ReadableStream for stdout/stderr,
// but bun-types types them as union. Cast helpers below:
type BunFileSink = import("bun").FileSink;
type BunReadableStream = ReadableStream<Uint8Array>;

// ── Types ─────────────────────────────────────────────────────────────────────

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── AgentSandbox ──────────────────────────────────────────────────────────────

/**
 * Manages one sandboxed Bun subprocess per agent.
 *
 * Protocol (newline-delimited JSON over stdin/stdout):
 *   Kernel → Agent  RpcRequest  { jsonrpc, id, method, params }
 *   Agent  → Kernel RpcSuccess  { jsonrpc, id, result }          (tool result)
 *   Agent  → Kernel RpcError    { jsonrpc, id, error }            (tool error)
 *   Agent  → Kernel RpcToolCall { jsonrpc, id, method:"kernel.call", params:{tool,args} }
 *                                                                (agent calling a kernel tool)
 */
export class AgentSandbox {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private lineBuffer = "";
  private _status: SandboxStatus = "stopped";
  private _startedAt: string | null = null;
  private _restarts = 0;
  private _lastError: string | null = null;

  /** Kernel tools available to this agent (filtered by permissions) */
  private kernelTools: Map<string, ToolDefinition> = new Map();

  constructor(private descriptor: AgentDescriptor) {}

  get name(): string {
    return this.descriptor.manifest.name;
  }

  get manifest(): AgentManifest {
    return this.descriptor.manifest;
  }

  get status(): SandboxStatus {
    return this._status;
  }

  getState(): SandboxState {
    return {
      name: this.name,
      status: this._status,
      pid: this.proc?.pid ?? null,
      startedAt: this._startedAt,
      restarts: this._restarts,
      lastError: this._lastError,
    };
  }

  /** Set kernel tools this sandbox may call (already permission-filtered) */
  setKernelTools(tools: ToolDefinition[]): void {
    this.kernelTools.clear();
    for (const t of tools) {
      this.kernelTools.set(t.name, t);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._status === "ready" || this._status === "starting") return;

    this._status = "starting";
    this._startedAt = isoNow();
    log.info(`[sandbox:${this.name}] Starting subprocess: ${this.descriptor.entryPath}`);

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...this.descriptor.manifest.env,
      // Never leak parent secrets to subprocess — only pass safe vars
      AGENT_NAME: this.name,
      AGENT_VERSION: this.descriptor.manifest.version,
    };

    try {
      this.proc = Bun.spawn(
        [process.execPath, this.descriptor.entryPath],
        {
          cwd: this.descriptor.dir,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      // Async stderr logging (non-blocking)
      this.pipeStderr();

      // Async stdout reading (line-delimited JSON)
      this.pipeStdout();

      this._status = "ready";
      log.info(`[sandbox:${this.name}] Ready (pid=${this.proc.pid})`);
    } catch (err) {
      this._status = "error";
      this._lastError = String(err);
      log.error(`[sandbox:${this.name}] Failed to start: ${err}`);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.proc) return;

    log.info(`[sandbox:${this.name}] Stopping`);
    // Reject all pending calls
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Sandbox stopped"));
      this.pending.delete(id);
    }

    try {
      this.proc.kill();
    } catch {
      // Already exited
    }
    this.proc = null;
    this._status = "stopped";
  }

  // ── RPC: Kernel → Agent ────────────────────────────────────────────────────

  /**
   * Call a tool registered by the agent (declared in manifest.tools).
   * Returns the result or throws on timeout/error.
   */
  async call(toolName: string, params: unknown): Promise<unknown> {
    if (this._status !== "ready") {
      throw new Error(`[sandbox:${this.name}] Not ready (status=${this._status})`);
    }
    if (!this.proc?.stdin) {
      throw new Error(`[sandbox:${this.name}] No stdin`);
    }

    const id = this.nextId++;
    const request: RpcRequest = { jsonrpc: "2.0", id, method: toolName, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[sandbox:${this.name}] Timeout calling "${toolName}" after ${this.manifest.timeoutMs}ms`));
      }, this.manifest.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const line = JSON.stringify(request) + "\n";
      (this.proc!.stdin as BunFileSink).write(line);
    });
  }

  // ── Stdout / line parsing ─────────────────────────────────────────────────

  private async pipeStdout(): Promise<void> {
    if (!this.proc?.stdout) return;

    const reader = (this.proc.stdout as BunReadableStream).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.lineBuffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = this.lineBuffer.split("\n");
        // Keep last incomplete chunk
        this.lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            await this.handleLine(trimmed);
          }
        }
      }
    } catch (err) {
      log.warn(`[sandbox:${this.name}] stdout reader error: ${err}`);
    }
  }

  private async handleLine(line: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log.warn(`[sandbox:${this.name}] Non-JSON stdout: ${line.slice(0, 200)}`);
      return;
    }

    if (!("jsonrpc" in msg) || !("id" in msg)) {
      log.warn(`[sandbox:${this.name}] Invalid RPC message`);
      return;
    }

    const id = msg.id as number;

    // Agent calling a kernel tool
    if (msg.method === "kernel.call") {
      await this.handleKernelCall(msg as unknown as RpcToolCall);
      return;
    }

    // Agent responding to a kernel→agent call
    const pending = this.pending.get(id);
    if (!pending) {
      log.warn(`[sandbox:${this.name}] No pending call for id=${id}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if ("error" in msg) {
      const err = (msg as unknown as RpcError).error;
      pending.reject(new Error(`[sandbox:${this.name}] RPC error ${err.code}: ${err.message}`));
    } else {
      pending.resolve((msg as unknown as RpcSuccess).result);
    }
  }

  /** Agent is calling a kernel tool — execute and send back result */
  private async handleKernelCall(msg: RpcToolCall): Promise<void> {
    const { tool, args } = msg.params;

    const toolDef = this.kernelTools.get(tool);
    if (!toolDef) {
      const errResponse: RpcError = {
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32601,
          message: `Tool not found or not permitted: ${tool}`,
        },
      };
      this.writeLine(JSON.stringify(errResponse));
      return;
    }

    try {
      const result = await toolDef.handler(args);
      const response: RpcSuccess = { jsonrpc: "2.0", id: msg.id, result };
      this.writeLine(JSON.stringify(response));
    } catch (err) {
      const response: RpcError = {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: String(err) },
      };
      this.writeLine(JSON.stringify(response));
    }
  }

  private writeLine(line: string): void {
    if (!this.proc?.stdin) return;
    try {
      (this.proc.stdin as BunFileSink).write(line + "\n");
    } catch (err) {
      log.warn(`[sandbox:${this.name}] Failed to write to stdin: ${err}`);
    }
  }

  // ── Stderr logging ────────────────────────────────────────────────────────

  private async pipeStderr(): Promise<void> {
    if (!this.proc?.stderr) return;

    const reader = (this.proc.stderr as BunReadableStream).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value).trim();
        if (text) {
          log.debug(`[sandbox:${this.name}] stderr: ${text}`);
        }
      }
    } catch {
      // Ignore
    }
  }
}

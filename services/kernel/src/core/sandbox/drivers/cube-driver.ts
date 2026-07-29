/**
 * CubeSandbox driver — built-in.
 *
 * CubeSandbox (https://github.com/tencentcloud/CubeSandbox) runs sandboxed
 * workloads in KVM MicroVMs with CoW snapshots. It exposes the E2B SDK's
 * HTTP surface, so any run becomes an API call to a preconfigured template.
 *
 * The driver does NOT require the E2B SDK to be installed — it talks to the
 * Cube HTTP API directly and delegates `cubemastercli` for sandbox control
 * when available.
 *
 * Workspace handling: we generate a wrapper script that shells out to
 * `cubemastercli` (or the HTTP API) with a bind-mount of the workspace.
 * Snapshot-based workspaces are opt-in via `--template` / `snapshotId`.
 *
 * IMPORTANT: CubeSandbox requires KVM on an x86_64 Linux host. If the
 * healthcheck fails at start(), the driver reports `ready=false` and the
 * executor falls back to whatever the agent declared as secondary.
 */

import { mkdirSync, writeFileSync, unlinkSync, chmodSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { log } from "../../logger.js";
import type {
  SandboxDriver,
  SandboxDriverStatus,
  SandboxCapabilities,
  SandboxHandle,
  SandboxRunOptions,
  ConfigField,
} from "../driver.js";

const WRAPPER_DIR = "/app/data/.cube-wrappers";

interface CubeDriverConfig {
  apiUrl: string;
  apiKey: string;
  templateId: string;
  cliPath: string;
  writableLayerSizeGb: number;
  memoryMb: number;
  cpus: number;
  egressAllowlist: string[];
}

const DEFAULTS: CubeDriverConfig = {
  apiUrl: "http://127.0.0.1:3000",
  apiKey: "dummy",
  templateId: "",
  cliPath: "cubemastercli",
  writableLayerSizeGb: 1,
  memoryMb: 2048,
  cpus: 2,
  egressAllowlist: [],
};

export class CubeSandboxDriver implements SandboxDriver {
  readonly slug = "cubesandbox";
  readonly name = "CubeSandbox (Tencent)";
  readonly capabilities: SandboxCapabilities = {
    snapshots: true,
    networkIsolation: "egress-policy",
    coldStartMs: 60,
    workspaceModel: "snapshot-clone",
    exec: true,
    resourceLimits: true,
  };

  private cfg: CubeDriverConfig = { ...DEFAULTS };
  private ready = false;
  private lastError = "";
  private daemonInfo: Record<string, unknown> = {};

  getConfigSchema(): ConfigField[] {
    return [
      {
        key: "apiUrl",
        label: "CubeAPI URL",
        type: "text",
        required: true,
        default: DEFAULTS.apiUrl,
        description: "E2B-compatible API endpoint exposed by CubeAPI.",
      },
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        required: false,
        default: DEFAULTS.apiKey,
        description: "Forwarded as X-API-Key. Cube accepts 'dummy' by default.",
      },
      {
        key: "templateId",
        label: "Default template ID",
        type: "text",
        required: false,
        default: DEFAULTS.templateId,
        description: "Create via `cubemastercli tpl create-from-image` and paste the ID here.",
      },
      {
        key: "cliPath",
        label: "cubemastercli binary",
        type: "text",
        required: false,
        default: DEFAULTS.cliPath,
        description: "Absolute path or command name (must be in $PATH).",
      },
      { key: "writableLayerSizeGb", label: "Writable layer size (GB)", type: "number", required: false, default: DEFAULTS.writableLayerSizeGb },
      { key: "memoryMb", label: "Memory (MB)", type: "number", required: false, default: DEFAULTS.memoryMb },
      { key: "cpus", label: "CPU cores", type: "number", required: false, default: DEFAULTS.cpus },
      {
        key: "egressAllowlist",
        label: "Egress allowlist (hosts, comma-separated)",
        type: "textarea",
        required: false,
        description: "CubeVS eBPF filter. Empty = full internet. Example: api.anthropic.com, github.com",
      },
    ];
  }

  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errs: string[] = [];
    if (config.apiUrl != null && typeof config.apiUrl !== "string") errs.push("apiUrl must be a string");
    if (typeof config.apiUrl === "string" && !/^https?:\/\//.test(config.apiUrl)) {
      errs.push("apiUrl must start with http:// or https://");
    }
    if (config.memoryMb != null && (typeof config.memoryMb !== "number" || config.memoryMb < 128)) {
      errs.push("memoryMb must be >= 128");
    }
    return errs.length ? { valid: false, errors: errs } : { valid: true };
  }

  configure(config: Record<string, unknown>): void {
    const allowlist = config.egressAllowlist;
    this.cfg = {
      apiUrl: typeof config.apiUrl === "string" ? config.apiUrl : DEFAULTS.apiUrl,
      apiKey: typeof config.apiKey === "string" ? config.apiKey : DEFAULTS.apiKey,
      templateId: typeof config.templateId === "string" ? config.templateId : DEFAULTS.templateId,
      cliPath: typeof config.cliPath === "string" ? config.cliPath : DEFAULTS.cliPath,
      writableLayerSizeGb: typeof config.writableLayerSizeGb === "number" ? config.writableLayerSizeGb : DEFAULTS.writableLayerSizeGb,
      memoryMb: typeof config.memoryMb === "number" ? config.memoryMb : DEFAULTS.memoryMb,
      cpus: typeof config.cpus === "number" ? config.cpus : DEFAULTS.cpus,
      egressAllowlist: Array.isArray(allowlist)
        ? (allowlist as unknown[]).filter((x): x is string => typeof x === "string")
        : (typeof allowlist === "string" ? allowlist.split(",").map((s) => s.trim()).filter(Boolean) : []),
    };
  }

  async start(): Promise<void> {
    // Healthcheck: GET {apiUrl}/health should return 200.
    try {
      const url = `${this.cfg.apiUrl.replace(/\/+$/, "")}/health`;
      const res = await fetch(url, {
        method: "GET",
        headers: this.cfg.apiKey ? { "X-API-Key": this.cfg.apiKey } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      this.daemonInfo = { apiUrl: this.cfg.apiUrl, health: body.slice(0, 200) };
      this.ready = true;
      this.lastError = "";
    } catch (err) {
      this.ready = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw new Error(`CubeAPI unreachable at ${this.cfg.apiUrl}: ${this.lastError}`);
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  getStatus(): SandboxDriverStatus {
    return {
      slug: this.slug,
      name: this.name,
      ready: this.ready,
      source: "builtin",
      capabilities: this.capabilities,
      error: this.lastError || undefined,
      info: this.daemonInfo,
    };
  }

  async prepareRun(opts: SandboxRunOptions): Promise<SandboxHandle> {
    mkdirSync(WRAPPER_DIR, { recursive: true });

    const templateId = opts.workspace.snapshotId || this.cfg.templateId;
    if (!templateId) {
      throw new Error(
        "CubeSandbox driver: no template ID configured. Set one in driver settings or pass workspace.snapshotId.",
      );
    }

    const sandboxName = `mtw-cube-${opts.runId.slice(0, 8)}-${Date.now()}`;
    const memoryMb = opts.resources?.memoryMb ?? this.cfg.memoryMb;
    const cpus = opts.resources?.cpus ?? this.cfg.cpus;

    // Inside CubeSandbox the agent runs as root of a dedicated VM kernel, so
    // the "bootstrap + creds copy" dance matters less — but we still honor it
    // for parity with Docker, using the same template structure.
    // Default to paths under the current user's home. Call sites can always
    // override via `opts.hostBinaries` or HOST_CLAUDE_* env vars when the
    // kernel runs as a different user or on a non-standard layout.
    const hostHome = process.env.HOST_HOME ?? homedir();
    const claudeCli = opts.hostBinaries?.claudeCli
      ?? process.env.HOST_CLAUDE_CLI
      ?? join(hostHome, ".local/bin/claude");
    const claudeJson = opts.hostBinaries?.claudeJson
      ?? process.env.HOST_CLAUDE_JSON
      ?? join(hostHome, ".claude.json");
    const claudeCreds = opts.hostBinaries?.claudeCreds
      ?? process.env.HOST_CLAUDE_CREDS
      ?? join(hostHome, ".claude/.credentials.json");

    const hostWorkspace = opts.workspace.hostPath || kernelPathToHost(opts.workspace.kernelPath);

    const envFlags: string[] = [];
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined || v === null) continue;
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) continue;
      envFlags.push(`--env ${shellQuote(`${k}=${String(v)}`)}`);
    }

    // Egress policy — Cube's eBPF switch accepts a comma-separated list.
    const egress = resolveEgress(opts.network, this.cfg.egressAllowlist);

    // Mounts for Cube: we use virtiofs via `--volume host:guest[:ro]` on the CLI.
    const mountArgs: string[] = [
      `--volume ${shellQuote(hostWorkspace)}:/workspace`,
      `--volume ${shellQuote(claudeCli)}:/usr/local/bin/claude:ro`,
      `--volume ${shellQuote(claudeJson)}:/mnt/claude.json:ro`,
      `--volume ${shellQuote(claudeCreds)}:/mnt/credentials.json:ro`,
    ];
    const skillNames: string[] = [];
    for (const s of opts.skillMounts ?? []) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(s.name)) continue;
      mountArgs.push(`--volume ${shellQuote(s.hostPath)}:/skills-readonly/${s.name}:ro`);
      skillNames.push(s.name);
    }
    for (const p of opts.pluginMounts ?? []) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(p.name)) continue;
      mountArgs.push(`--volume ${shellQuote(p.hostPath)}:/plugins/${p.name}:ro`);
    }
    for (const m of opts.extraMounts ?? []) {
      mountArgs.push(`--volume ${shellQuote(m.host)}:${shellQuote(m.container)}${m.readonly ? ":ro" : ""}`);
    }

    const bootstrapPath = resolve(WRAPPER_DIR, `${opts.runId}-bootstrap.sh`);
    const skillLinkLines: string[] = [];
    if (skillNames.length > 0) {
      skillLinkLines.push('mkdir -p "$HOME/.claude/skills"');
      for (const name of skillNames) {
        skillLinkLines.push(`ln -sfn /skills-readonly/${name} "$HOME/.claude/skills/${name}"`);
      }
    }
    const entry = opts.entryCommand ?? 'claude "$@"';
    const bootstrap = [
      "#!/bin/sh",
      "set -e",
      'mkdir -p "$HOME/.claude"',
      'cp /mnt/claude.json "$HOME/.claude.json"',
      'cp /mnt/credentials.json "$HOME/.claude/.credentials.json"',
      'chmod 600 "$HOME/.claude.json" "$HOME/.claude/.credentials.json"',
      ...skillLinkLines,
      `exec ${entry}`,
      "",
    ].join("\n");
    writeFileSync(bootstrapPath, bootstrap, { encoding: "utf-8" });
    chmodSync(bootstrapPath, 0o755);
    mountArgs.push(`--volume ${shellQuote(kernelPathToHost(bootstrapPath))}:/bootstrap.sh:ro`);

    // Build the CLI invocation. We go through `cubemastercli` because it
    // handles stdin/stdout wiring end-to-end; the raw HTTP API would require
    // a separate relay process.
    const apiUrlEnv = `CUBE_API_URL=${shellQuote(this.cfg.apiUrl)}`;
    const apiKeyEnv = `CUBE_API_KEY=${shellQuote(this.cfg.apiKey)}`;
    const egressFlag = egress.length > 0 ? `--egress-allow ${shellQuote(egress.join(","))}` : "";
    const cliCmd = [
      shellQuote(this.cfg.cliPath),
      "sandbox",
      "run",
      `--name ${sandboxName}`,
      `--template ${shellQuote(templateId)}`,
      `--memory-mb ${memoryMb}`,
      `--cpus ${cpus}`,
      `--writable-layer-size ${this.cfg.writableLayerSizeGb}G`,
      egressFlag,
      ...mountArgs,
      ...envFlags,
      "--stdin --tty=false",
      "--workdir /workspace",
      "--",
      "/bootstrap.sh \"$@\"",
    ].filter(Boolean).join(" \\\n  ");

    const script = [
      "#!/bin/sh",
      "# Auto-generated by CubeSandboxDriver. Do not edit.",
      `# Sandbox for run ${opts.runId} — template ${templateId}`,
      "set -e",
      "",
      `export ${apiUrlEnv}`,
      `export ${apiKeyEnv}`,
      "",
      `exec ${cliCmd}`,
      "",
    ].join("\n");

    const scriptPath = resolve(WRAPPER_DIR, `${opts.runId}.sh`);
    writeFileSync(scriptPath, script, { encoding: "utf-8" });
    chmodSync(scriptPath, 0o755);

    log.debug(`CubeSandboxDriver: wrapper ready → ${scriptPath} (sandbox=${sandboxName}, template=${templateId})`);

    return {
      executablePath: scriptPath,
      instanceId: sandboxName,
      driver: this.slug,
      startedAt: new Date().toISOString(),
      snapshotBase: templateId,
    };
  }

  async cleanup(handle: SandboxHandle): Promise<void> {
    try { unlinkSync(handle.executablePath); } catch { /* already gone */ }
    const bootstrap = handle.executablePath.replace(/\.sh$/, "-bootstrap.sh");
    try { unlinkSync(bootstrap); } catch { /* already gone */ }

    // Best-effort: ask cubemastercli to garbage-collect the sandbox. If the
    // process already exited and Cube reaped it, this is a no-op.
    if (existsOnPath(this.cfg.cliPath)) {
      try {
        execFileSync(
          this.cfg.cliPath,
          ["sandbox", "rm", "--name", handle.instanceId, "--force"],
          { stdio: ["ignore", "ignore", "ignore"], timeout: 5_000 },
        );
      } catch { /* ignored */ }
    }
  }
}

export function createDriver(): SandboxDriver {
  return new CubeSandboxDriver();
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveEgress(
  n: SandboxRunOptions["network"],
  defaultAllow: string[],
): string[] {
  if (n === "none") return ["__deny_all__"];
  if (!n || n === "bridge") return defaultAllow;
  if (typeof n === "object" && n.mode === "egress-policy") return n.allowHosts;
  return defaultAllow;
}

function kernelPathToHost(p: string): string {
  const hostRoot = process.env.HOST_KERNEL_ROOT;
  if (hostRoot && p.startsWith("/app/")) {
    return p.replace(/^\/app/, hostRoot);
  }
  return p;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function existsOnPath(cmd: string): boolean {
  if (cmd.startsWith("/") && existsSync(cmd)) return true;
  try {
    execSync(`command -v ${shellQuote(cmd)}`, { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

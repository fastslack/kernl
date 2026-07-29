/**
 * Docker sandbox driver — built-in.
 *
 * Each run spawns `docker run --rm -i <image>` with:
 *   - /workspace bind-mount of the agent's cwd
 *   - claude CLI + credentials mounted read-only
 *   - a bootstrap.sh that copies creds to $HOME and execs `claude "$@"`
 *   - resource caps + UID 1000 + no capabilities by default
 *
 * Host-vs-kernel path translation (Docker-in-Docker) handled the same way
 * the previous `claude-sandbox.ts` did — via `HOST_KERNEL_ROOT` env var.
 */

import { mkdirSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { log } from "../../logger.js";
import type {
  SandboxDriver,
  SandboxDriverStatus,
  SandboxCapabilities,
  SandboxHandle,
  SandboxRunOptions,
  ConfigField,
} from "../driver.js";

const WRAPPER_DIR = "/app/data/.claude-wrappers";

interface DockerDriverConfig {
  defaultImage: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  defaultNetwork: "bridge" | "none";
  runAs: string;
}

const DEFAULTS: DockerDriverConfig = {
  defaultImage: "oven/bun:1",
  memoryMb: 1024,
  cpus: 2,
  pidsLimit: 500,
  defaultNetwork: "bridge",
  runAs: "1000:1000",
};

export class DockerSandboxDriver implements SandboxDriver {
  readonly slug = "docker";
  readonly name = "Docker";
  readonly capabilities: SandboxCapabilities = {
    snapshots: false,
    networkIsolation: "bridge",
    coldStartMs: 200,
    workspaceModel: "bind-mount",
    exec: true,
    resourceLimits: true,
  };

  private cfg: DockerDriverConfig = { ...DEFAULTS };
  private ready = false;
  private lastError = "";
  private daemonInfo: Record<string, unknown> = {};

  getConfigSchema(): ConfigField[] {
    return [
      {
        key: "defaultImage",
        label: "Default image",
        type: "text",
        required: false,
        default: DEFAULTS.defaultImage,
        description: "Docker image used when the agent doesn't override __sandbox_image__.",
      },
      { key: "memoryMb", label: "Memory (MB)", type: "number", required: false, default: DEFAULTS.memoryMb },
      { key: "cpus", label: "CPU cores", type: "number", required: false, default: DEFAULTS.cpus },
      { key: "pidsLimit", label: "PIDs limit", type: "number", required: false, default: DEFAULTS.pidsLimit },
      {
        key: "defaultNetwork",
        label: "Default network",
        type: "select",
        required: false,
        default: DEFAULTS.defaultNetwork,
        options: [
          { value: "bridge", label: "Bridge (internet access)" },
          { value: "none", label: "None (offline)" },
        ],
      },
      {
        key: "runAs",
        label: "Run as UID:GID",
        type: "text",
        required: false,
        default: DEFAULTS.runAs,
        description: "Non-root identity inside the container.",
      },
    ];
  }

  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errs: string[] = [];
    if (config.memoryMb != null && (typeof config.memoryMb !== "number" || config.memoryMb < 128)) {
      errs.push("memoryMb must be >= 128");
    }
    if (config.cpus != null && (typeof config.cpus !== "number" || config.cpus <= 0)) {
      errs.push("cpus must be > 0");
    }
    if (config.runAs != null && typeof config.runAs === "string" && !/^\d+:\d+$/.test(config.runAs)) {
      errs.push("runAs must be '<uid>:<gid>'");
    }
    return errs.length ? { valid: false, errors: errs } : { valid: true };
  }

  configure(config: Record<string, unknown>): void {
    this.cfg = {
      defaultImage: typeof config.defaultImage === "string" ? config.defaultImage : DEFAULTS.defaultImage,
      memoryMb: typeof config.memoryMb === "number" ? config.memoryMb : DEFAULTS.memoryMb,
      cpus: typeof config.cpus === "number" ? config.cpus : DEFAULTS.cpus,
      pidsLimit: typeof config.pidsLimit === "number" ? config.pidsLimit : DEFAULTS.pidsLimit,
      defaultNetwork: config.defaultNetwork === "none" ? "none" : DEFAULTS.defaultNetwork,
      runAs: typeof config.runAs === "string" && /^\d+:\d+$/.test(config.runAs) ? config.runAs : DEFAULTS.runAs,
    };
  }

  async start(): Promise<void> {
    // Healthcheck: docker daemon reachable.
    try {
      const out = execSync("docker version --format '{{.Server.Version}}'", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      this.daemonInfo = { serverVersion: out };
      this.ready = true;
      this.lastError = "";
    } catch (err) {
      this.ready = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw new Error(`Docker daemon unreachable: ${this.lastError}`);
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

    const image = opts.image ?? this.cfg.defaultImage;
    const memoryMb = opts.resources?.memoryMb ?? this.cfg.memoryMb;
    const cpus = opts.resources?.cpus ?? this.cfg.cpus;
    const pidsLimit = opts.resources?.pidsLimit ?? this.cfg.pidsLimit;
    const network = resolveNetwork(opts.network ?? this.cfg.defaultNetwork);
    const containerName = `mtw-claude-${opts.runId.slice(0, 8)}-${Date.now()}`;

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
      envFlags.push(`  -e ${k}=${shellQuote(String(v))} \\`);
    }

    const skillNames: string[] = [];
    const mounts: string[] = [
      `  --tmpfs /sandbox-home:uid=1000,gid=1000,mode=0700 \\`,
      `  -v ${shellQuote(hostWorkspace)}:/workspace \\`,
      `  -v ${shellQuote(claudeCli)}:/usr/local/bin/claude:ro \\`,
      `  -v ${shellQuote(claudeJson)}:/mnt/claude.json:ro \\`,
      `  -v ${shellQuote(claudeCreds)}:/mnt/credentials.json:ro \\`,
    ];

    for (const s of opts.skillMounts ?? []) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(s.name)) continue;
      mounts.push(`  -v ${shellQuote(s.hostPath)}:/skills-readonly/${s.name}:ro \\`);
      skillNames.push(s.name);
    }
    for (const p of opts.pluginMounts ?? []) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(p.name)) continue;
      mounts.push(`  -v ${shellQuote(p.hostPath)}:/plugins/${p.name}:ro \\`);
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
    mounts.push(`  -v ${shellQuote(kernelPathToHost(bootstrapPath))}:/bootstrap.sh:ro \\`);

    for (const m of opts.extraMounts ?? []) {
      mounts.push(`  -v ${shellQuote(m.host)}:${shellQuote(m.container)}${m.readonly ? ":ro" : ""} \\`);
    }

    const script = [
      "#!/bin/sh",
      "# Auto-generated by DockerSandboxDriver. Do not edit.",
      `# Sandbox container for run ${opts.runId}`,
      "set -e",
      "",
      "exec docker run --rm -i \\",
      `  --name ${containerName} \\`,
      `  --network=${shellQuote(network)} \\`,
      `  --user ${this.cfg.runAs} \\`,
      `  --memory=${memoryMb}m --cpus=${cpus} --pids-limit=${pidsLimit} \\`,
      `  --workdir=/workspace \\`,
      `  -e HOME=/sandbox-home \\`,
      ...envFlags,
      ...mounts,
      `  ${shellQuote(image)} \\`,
      `  /bootstrap.sh "$@"`,
      "",
    ].join("\n");

    const scriptPath = resolve(WRAPPER_DIR, `${opts.runId}.sh`);
    writeFileSync(scriptPath, script, { encoding: "utf-8" });
    chmodSync(scriptPath, 0o755);

    log.debug(`DockerSandboxDriver: wrapper ready → ${scriptPath} (container=${containerName})`);

    return {
      executablePath: scriptPath,
      instanceId: containerName,
      driver: this.slug,
      startedAt: new Date().toISOString(),
    };
  }

  async cleanup(handle: SandboxHandle): Promise<void> {
    try { unlinkSync(handle.executablePath); } catch { /* already gone */ }
    const bootstrap = handle.executablePath.replace(/\.sh$/, "-bootstrap.sh");
    try { unlinkSync(bootstrap); } catch { /* already gone */ }
  }
}

/** Factory — exported so the registry can instantiate on demand. */
export function createDriver(): SandboxDriver {
  return new DockerSandboxDriver();
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveNetwork(n: SandboxRunOptions["network"]): string {
  if (n === "none") return "none";
  if (!n || n === "bridge") return "bridge";
  // Egress-policy isn't natively supported by docker — collapse to bridge.
  if (typeof n === "object") return "bridge";
  // Plain string → named docker network (e.g. "kernl_default" so the
  // agent container joins the kernel's compose net and `kernel:3087/mcp`
  // resolves). Operator is responsible for ensuring the network exists.
  // Reject anything outside docker's legal network-name charset so an
  // agent-controlled `__sandbox_network__` can't inject extra docker flags.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(n)) return "bridge";
  return n;
}

export function kernelPathToHost(p: string): string {
  const hostRoot = process.env.HOST_KERNEL_ROOT;
  if (hostRoot && p.startsWith("/app/")) {
    return p.replace(/^\/app/, hostRoot);
  }
  return p;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

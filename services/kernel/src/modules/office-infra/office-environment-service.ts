import { spawnSync } from "node:child_process";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { isoNow } from "../../core/helpers.js";
import { kernelPathToHost } from "../../core/sandbox/drivers/docker-driver.js";
import type {
  OfficeEnvRow,
  OfficeEnvState,
  OfficeEnvStatus,
  DockerRunner,
  DockerResult,
} from "./types.js";

/** Real docker runner: arg-array spawn (no shell), 30s timeout. */
function defaultDockerRunner(args: string[]): DockerResult {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
  return {
    code: typeof r.status === "number" ? r.status : 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
  };
}

/** Sanitize a flow id into a docker-safe container-name suffix. */
function safeName(flowId: string): string {
  return flowId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
}

export interface OfficeEnvConfigPatch {
  image?: string;
  ports?: string[];
  env?: Record<string, string>;
  network?: string;
  run_command?: string;
  workspace_subpath?: string;
}

/** Minimal event-emitter surface — only `emit` is used, kept loose so the
 *  service stays decoupled from the concrete EventBus class. */
export interface InfraEventSink {
  emit(event: string, payload: unknown): void;
}

export class OfficeEnvironmentService {
  constructor(
    private db: SqliteDb,
    private runDocker: DockerRunner = defaultDockerRunner,
    private events?: InfraEventSink,
  ) {}

  /** Emit `office:infra:changed` so the 3D office can animate the responsible
   *  agent walking to the Repos Office and toggling the rack. `state` is the
   *  resulting desired state (running/stopped/paused) or "error" on failure. */
  private emitChange(flowId: string, action: string, ok: boolean, error: string): void {
    if (!this.events) return;
    let row: OfficeEnvRow | undefined;
    try { row = this.db.prepare("SELECT * FROM office_environments WHERE flow_id = ?").get(flowId) as OfficeEnvRow | undefined; } catch { /* table absent */ }
    const state = ok ? (row?.desired_state ?? "running") : "error";
    this.events.emit("office:infra:changed", {
      flow_id: flowId,
      action,
      ok,
      state,
      container_name: row?.container_name ?? "",
      image: row?.image ?? "",
      error: error.slice(0, 300),
      ts: isoNow(),
    });
  }

  /** Run a lifecycle action, emitting a change event on both success and
   *  failure (the failure event still rethrows so the HTTP route 400s). */
  private runAction(flowId: string, action: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.emitChange(flowId, action, false, e instanceof Error ? e.message : String(e));
      throw e;
    }
    this.emitChange(flowId, action, true, "");
  }

  /** All office_environments rows (cached states only — no live docker
   *  inspect) so the dashboard can paint every office's infra badge on load
   *  without N blocking `docker inspect` calls. */
  list(): Array<{ flow_id: string; desired_state: string; last_status: string; container_name: string; image: string }> {
    try {
      return this.db
        .prepare("SELECT flow_id, desired_state, last_status, container_name, image FROM office_environments")
        .all() as Array<{ flow_id: string; desired_state: string; last_status: string; container_name: string; image: string }>;
    } catch {
      return [];
    }
  }

  /** Whether a flow with this id exists. Validates against agent_flows so we
   *  never create office_environments rows for phantom flows. Graceful if the
   *  agent_flows table isn't present (e.g. an isolated context). */
  private flowExists(flowId: string): boolean {
    try {
      return !!this.db.prepare("SELECT id FROM agent_flows WHERE id = ?").get(flowId);
    } catch {
      return true; // agent_flows not migrated here — skip the check
    }
  }

  /** Read the office env row, creating a default one on first access. */
  get(flowId: string): OfficeEnvRow {
    const existing = this.db
      .prepare("SELECT * FROM office_environments WHERE flow_id = ?")
      .get(flowId) as OfficeEnvRow | undefined;
    if (existing) return existing;

    if (!this.flowExists(flowId)) {
      throw new Error(`office (flow) not found: ${flowId}`);
    }

    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO office_environments
           (flow_id, container_name, workspace_subpath, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        flowId,
        `mtw-office-${safeName(flowId)}`,
        `data/workspaces/${flowId}`,
        now,
        now,
      );
    return this.get(flowId);
  }

  /**
   * Host repo path bound to this office's flow (`agent_flows.home_repo_path`),
   * or null if unset. Used to inject the repo location into office_exec commands
   * (env `KERNEL_HOME_REPO`) so extension scripts don't hardcode it.
   */
  homeRepoPath(flowId: string): string | null {
    try {
      const row = this.db
        .prepare("SELECT home_repo_path FROM agent_flows WHERE id = ?")
        .get(flowId) as { home_repo_path?: string } | undefined;
      const p = row?.home_repo_path?.trim();
      return p ? p : null;
    } catch {
      return null;
    }
  }

  /** Apply a validated config patch and return the updated row. */
  configure(flowId: string, patch: OfficeEnvConfigPatch): OfficeEnvRow {
    const row = this.get(flowId);
    const next: OfficeEnvRow = { ...row };

    if (patch.image !== undefined) {
      if (typeof patch.image !== "string" || !patch.image.trim()) {
        throw new Error("image must be a non-empty string");
      }
      next.image = patch.image.trim();
    }
    if (patch.ports !== undefined) {
      if (
        !Array.isArray(patch.ports) ||
        !patch.ports.every((p) => typeof p === "string" && /^\d+:\d+$/.test(p))
      ) {
        throw new Error('ports must be an array of "hostPort:containerPort" strings');
      }
      next.ports_json = JSON.stringify(patch.ports);
    }
    if (patch.env !== undefined) {
      if (
        typeof patch.env !== "object" || patch.env === null ||
        !Object.values(patch.env).every((v) => typeof v === "string")
      ) {
        throw new Error("env must be an object of string values");
      }
      for (const k of Object.keys(patch.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          throw new Error(`invalid env key "${k}": must match [A-Za-z_][A-Za-z0-9_]*`);
        }
      }
      next.env_json = JSON.stringify(patch.env);
    }
    if (patch.network !== undefined) {
      if (typeof patch.network !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(patch.network)) {
        throw new Error("network must be a valid docker network name");
      }
      next.network = patch.network;
    }
    if (patch.run_command !== undefined) {
      if (typeof patch.run_command !== "string") throw new Error("run_command must be a string");
      next.run_command = patch.run_command;
    }
    if (patch.workspace_subpath !== undefined) {
      const sp = String(patch.workspace_subpath);
      if (!sp.startsWith("data/") || sp.includes("..")) {
        throw new Error("workspace_subpath must be under data/ and contain no ..");
      }
      next.workspace_subpath = sp;
    }

    next.updated_at = isoNow();
    this.db
      .prepare(
        `UPDATE office_environments SET
           image = ?, ports_json = ?, env_json = ?, network = ?,
           run_command = ?, workspace_subpath = ?, updated_at = ?
         WHERE flow_id = ?`,
      )
      .run(
        next.image, next.ports_json, next.env_json, next.network,
        next.run_command, next.workspace_subpath, next.updated_at, flowId,
      );
    return this.get(flowId);
  }

  /** Resolve the host path to bind-mount at /workspace (docker daemon is the host's). */
  private hostWorkspace(row: OfficeEnvRow): string {
    return kernelPathToHost(`/app/${row.workspace_subpath}`);
  }

  /** Run docker, throw on non-zero exit (recording last_error), else return stdout. */
  private docker(flowId: string, args: string[]): string {
    const r = this.runDocker(args);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || `docker ${args[0]} failed`).trim();
      this.recordError(flowId, msg);
      throw new Error(msg);
    }
    return r.stdout;
  }

  private recordError(flowId: string, msg: string): void {
    this.db
      .prepare("UPDATE office_environments SET last_error = ?, last_status = 'error', last_status_at = ? WHERE flow_id = ?")
      .run(msg.slice(0, 500), isoNow(), flowId);
  }

  private setDesired(flowId: string, state: OfficeEnvRow["desired_state"]): void {
    this.db
      .prepare("UPDATE office_environments SET desired_state = ?, last_error = '', updated_at = ? WHERE flow_id = ?")
      .run(state, isoNow(), flowId);
  }

  /** Create + start the office container. Removes a stale labelled one first. */
  up(flowId: string): void {
    this.runAction(flowId, "up", () => {
      const row = this.get(flowId);
      // Force-remove any stale container with our name (ignore failure: may not exist).
      this.runDocker(["rm", "-f", row.container_name]);

      const ports: string[] = JSON.parse(row.ports_json);
      const env: Record<string, string> = JSON.parse(row.env_json);
      const args = [
        "run", "-d",
        "--name", row.container_name,
        "--label", `mtw.office=${flowId}`,
        "--network", row.network,
        "-v", `${this.hostWorkspace(row)}:/workspace`,
        "-w", "/workspace",
      ];
      // DEPLOY offices: mount the host home (SSH keys, glab config, repos) —
      // RW because deploys write (commit/worktree). ONLY when the office asks for
      // it with KERNEL_MOUNT_HOME=1 in its env (never by default → security).
      if (env.KERNEL_MOUNT_HOME === "1") {
        const hostHome = process.env.HOST_HOME || process.env.HOME || "/root";
        args.push("-v", `${hostHome}:${hostHome}`);
      }
      for (const p of ports) args.push("-p", p);
      for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
      // --entrypoint sh: ignores the image's own ENTRYPOINT (e.g. kernl-kernel
      // boots the whole kernel → kills the container) and leave a neutral shell
      // with the image's toolchain, running run_command (or sleep infinity).
      args.push("--entrypoint", "sh");
      args.push(row.image, "-c", row.run_command.trim() || "sleep infinity");
      this.docker(flowId, args);
      this.setDesired(flowId, "running");
    });
  }

  pause(flowId: string): void {
    this.runAction(flowId, "pause", () => {
      const row = this.get(flowId);
      this.docker(flowId, ["pause", row.container_name]);
      this.setDesired(flowId, "paused");
    });
  }

  resume(flowId: string): void {
    this.runAction(flowId, "resume", () => {
      const row = this.get(flowId);
      this.docker(flowId, ["unpause", row.container_name]);
      this.setDesired(flowId, "running");
    });
  }

  stop(flowId: string): void {
    this.runAction(flowId, "stop", () => {
      const row = this.get(flowId);
      this.docker(flowId, ["stop", row.container_name]);
      this.setDesired(flowId, "stopped");
    });
  }

  restart(flowId: string): void {
    this.runAction(flowId, "restart", () => {
      const row = this.get(flowId);
      this.docker(flowId, ["restart", row.container_name]);
      this.setDesired(flowId, "running");
    });
  }

  /** Derive the preview URL from the first host port mapping, if any. */
  private previewUrl(row: OfficeEnvRow): string | null {
    const ports: string[] = JSON.parse(row.ports_json);
    if (!ports.length) return null;
    const hostPort = ports[0].split(":")[0];
    return `http://localhost:${hostPort}`;
  }

  /** Inspect the container and return a normalized status (also caches it). */
  status(flowId: string): OfficeEnvStatus {
    const row = this.get(flowId);
    const r = this.runDocker(["inspect", "--format", "{{json .State}}", row.container_name]);

    let state: OfficeEnvState;
    let lastError = "";
    if (r.code === 0) {
      let dockerState = "";
      try {
        const parsed = JSON.parse(r.stdout.trim());
        // `--format {{json .State}}` returns the State object directly.
        dockerState = (parsed as { Status?: string }).Status ?? "";
        // Some docker versions / plain `inspect` return an array; tolerate it.
        if (!dockerState && Array.isArray(parsed)) {
          dockerState =
            (parsed as Array<{ State?: { Status?: string } }>)[0]?.State?.Status ?? "";
        }
      } catch { dockerState = ""; }
      state =
        dockerState === "running" ? "running" :
        // "restarting" is in-use — treat as running so the UI doesn't offer
        // "Start" (which would force-remove a transitioning container).
        dockerState === "restarting" ? "running" :
        dockerState === "paused" ? "paused" :
        dockerState === "created" ? "created" :
        dockerState === "exited" || dockerState === "dead" ? "exited" :
        "absent";
    } else {
      const err = (r.stderr || r.stdout || "").trim();
      if (/cannot connect to the docker daemon|is the docker daemon running|permission denied/i.test(err)) {
        state = "error";
        lastError = err;
      } else {
        // "No such object" etc → the container simply doesn't exist.
        state = "absent";
      }
    }

    this.db
      .prepare("UPDATE office_environments SET last_status = ?, last_status_at = ?, last_error = ? WHERE flow_id = ?")
      .run(state, isoNow(), lastError, flowId);

    return {
      flow_id: flowId,
      state,
      image: row.image,
      container_name: row.container_name,
      preview_url: state === "running" ? this.previewUrl(row) : null,
      desired_state: row.desired_state,
      last_error: lastError,
    };
  }
}

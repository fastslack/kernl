/**
 * Point an office at a host folder (usually a git repo), or take it back to
 * its kernel workspace. One implementation for the MCP tool
 * `kernel_agents_flows_set_repo`, `PUT /api/agents/flows/:id/repo` and the
 * `agents.flows.set_repo` RPC action.
 */
import { mkdirSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import { HttpError } from "../../sdk/http-error.js";
import { seedOfficeHome } from "./office-home.js";
import type { AgentService } from "./service.js";
import type { AgentFlow } from "./types.js";

export class OfficeRepoError extends HttpError {
  constructor(message: string, status: 400 | 404) {
    super(status, message);
    this.name = "OfficeRepoError";
  }
}

export type GitInitOutcome = "done" | "already" | "skipped" | "missing" | "failed";

export interface SetOfficeRepoInput {
  flow_id: string;
  /** Absolute host path to promote to; empty or null reverts to the kernel workspace. */
  path?: string | null;
  /** Run `git init` when the folder is not a repo yet. Default true. */
  git_init?: boolean;
  /**
   * Also move the agents that carry the office's previous repo in their own
   * `__cwd_path__` (Office Kit writes the repo there, not in home_repo_path).
   * The MCP tool leaves this off and keeps its historical behavior.
   */
  retarget_agents?: boolean;
}

export interface SetOfficeRepoResult {
  flow: AgentFlow;
  /** The new repo path; '' when reverted. */
  path: string;
  /** Where agents without their own cwd work now. */
  homePath: string | null;
  git: GitInitOutcome;
  gitDetail: string;
  retargeted: number;
}

function parseVars(raw: string | undefined): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The repo an office works on today: its home_repo_path, or — for offices
 * built by Office Kit — the one `__cwd_path__` its agents share. Different
 * paths, or none, mean no office repo.
 */
export function previousOfficeRepo(homeRepoPath: string | undefined, agentVariables: Array<string | undefined>): string {
  if (homeRepoPath) return homeRepoPath;
  const paths = new Set<string>();
  for (const raw of agentVariables) {
    const cwd = parseVars(raw)?.__cwd_path__;
    if (typeof cwd === "string" && cwd.trim()) paths.add(cwd.trim());
  }
  return paths.size === 1 ? [...paths][0] : "";
}

export function setOfficeRepo(service: AgentService, input: SetOfficeRepoInput): SetOfficeRepoResult {
  const flowId = input.flow_id?.trim() ?? "";
  if (!flowId) throw new OfficeRepoError("flow_id is required", 400);
  const flow = service.getFlow(flowId);
  if (!flow) throw new OfficeRepoError(`Flow not found: ${flowId}`, 404);

  const raw = input.path?.trim() ?? "";
  if (raw && !isAbsolute(raw)) {
    throw new OfficeRepoError("path must be absolute (e.g. /home/you/office or C:\\Users\\you\\office)", 400);
  }

  const members = service.listAgents().filter((a) => a.flow_id === flowId);
  const previous = previousOfficeRepo(flow.home_repo_path, members.map((a) => a.variables));

  let git: GitInitOutcome = "skipped";
  let gitDetail = "";
  if (raw) {
    mkdirSync(raw, { recursive: true });
    if (input.git_init !== false) {
      if (existsSync(join(raw, ".git"))) {
        git = "already";
      } else {
        const r = spawnSync("git", ["init"], { cwd: raw, encoding: "utf8" });
        const gitMissing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
        if (r.status === 0) {
          git = "done";
        } else if (gitMissing) {
          git = "missing";
        } else {
          git = "failed";
          gitDetail = (r.stderr || r.error?.message || "git unavailable").toString().trim().slice(0, 120);
        }
      }
    }
    try {
      seedOfficeHome(raw, flow);
    } catch (err) {
      log.warn(`set_repo: seedOfficeHome failed for ${raw}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let retargeted = 0;
  // One transaction: the office row, its agents' variables and its isolation move together.
  const commit = service.getDb().transaction(() => {
    service.setFlowRepo(flowId, raw);
    if (input.retarget_agents && previous && previous !== raw) {
      const write = service.getDb().prepare("UPDATE agents SET variables = ?, updated_at = ? WHERE id = ?");
      for (const agent of members) {
        const vars = parseVars(agent.variables);
        if (!vars || vars.__cwd_path__ !== previous) continue;
        if (raw) {
          vars.__cwd_path__ = raw;
        } else {
          delete vars.__cwd_path__;
          delete vars.__sandbox__;
          delete vars.__permission_mode__;
        }
        write.run(JSON.stringify(vars), isoNow(), agent.id);
        retargeted++;
      }
    }
    if (input.retarget_agents) {
      if (!raw) {
        // '' = the office has no repo (types.ts:26); a stale host/sandbox would resurface on the next repo.
        service.getDb().prepare("UPDATE agent_flows SET repo_isolation = '', updated_at = ? WHERE id = ?").run(isoNow(), flowId);
      } else if (!flow.repo_isolation) {
        // First repo for this office: the safe default, propagated to the agents that carry a __cwd_path__.
        service.updateFlow(flowId, { repo_isolation: "sandbox" });
      }
    }
  });
  commit();
  const updated = service.getFlow(flowId) ?? flow;

  return {
    flow: updated,
    path: raw,
    homePath: service.resolveFlowHome(flowId)?.path ?? null,
    git,
    gitDetail,
    retargeted,
  };
}

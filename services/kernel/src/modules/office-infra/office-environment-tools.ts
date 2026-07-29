import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { textResult, errorResult } from "../../core/helpers.js";
import type { ToolDefinition } from "../../core/types.js";
import type { OfficeEnvironmentService } from "./office-environment-service.js";
import { defineTool } from "../../core/tool-builder.js";

const execFileAsync = promisify(execFile);

const flowIdSchema = z.object({ flow_id: z.string().describe("Office (flow) id") });

function fmtStatus(s: ReturnType<OfficeEnvironmentService["status"]>): string {
  const lines = [
    `**Office env** \`${s.flow_id}\``,
    `- state: **${s.state}** (desired: ${s.desired_state})`,
    `- container: \`${s.container_name}\``,
    `- image: \`${s.image}\``,
  ];
  if (s.preview_url) lines.push(`- preview: ${s.preview_url}`);
  if (s.last_error) lines.push(`- error: ${s.last_error}`);
  return lines.join("\n");
}

export function officeEnvTools(service: OfficeEnvironmentService): ToolDefinition[] {
  const verb = (
    name: string,
    description: string,
    run: (flowId: string) => void,
  ): ToolDefinition =>
    defineTool({
      name,
      description,
      schema: flowIdSchema,
      handler: async ({ flow_id }) => {
        run(flow_id);
        return textResult(fmtStatus(service.status(flow_id)));
      },
    });

  return [
    defineTool({
      name: "kernel_office_env_get",
      description: "Get the configuration + cached status of an office's virtual environment.",
      schema: flowIdSchema,
      handler: async ({ flow_id }) => {
        const row = service.get(flow_id);
        return textResult(
          [
            `**Office env config** \`${flow_id}\``,
            `- image: \`${row.image}\``,
            `- container: \`${row.container_name}\``,
            `- workspace: \`${row.workspace_subpath}\` → /workspace`,
            `- ports: ${row.ports_json}`,
            `- network: ${row.network}`,
            `- run_command: ${row.run_command || "(sleep infinity)"}`,
            `- desired_state: ${row.desired_state}`,
          ].join("\n"),
        );
      },
    }),
    defineTool({
      name: "kernel_office_env_status",
      description: "Inspect the live status of an office's virtual environment.",
      schema: flowIdSchema,
      handler: async ({ flow_id }) => {
        return textResult(fmtStatus(service.status(flow_id)));
      },
    }),
    defineTool({
      name: "kernel_office_env_configure",
      description: "Configure an office's virtual environment (image, ports, env, network, run_command, workspace_subpath).",
      schema: z.object({
        flow_id: z.string(),
        image: z.string().optional(),
        ports: z.array(z.string()).optional().describe('e.g. ["4321:4321"]'),
        env: z.record(z.string()).optional(),
        network: z.string().optional(),
        run_command: z.string().optional(),
        workspace_subpath: z.string().optional().describe("kernel-relative, must be under data/"),
      }),
      handler: async ({ flow_id, ...patch }) => {
        service.configure(flow_id, patch);
        return textResult(fmtStatus(service.status(flow_id)));
      },
    }),
    defineTool({
      name: "kernel_office_exec",
      description: "Run a command INSIDE an office's container (must be 'running'). For running deploy/git/scripts with the office container's toolchain and secrets.",
      schema: z.object({
        flow_id: z.string(),
        command: z.string().describe("Shell command, e.g.: 'bash scripts/issues/approve-fix.sh web 2080'"),
        workdir: z.string().optional().describe("cwd inside the container (default: the image's WORKDIR)"),
        timeout_ms: z.number().optional().describe("default 600000 (10min), max 1800000 (30min)"),
      }),
      handler: async ({ flow_id, command, workdir, timeout_ms }) => {
        try {
          const st = service.status(flow_id);
          if (st.state !== "running") {
            return errorResult(`The office's container is '${st.state}', not 'running'. Start it first (kernel_office_env_up).`);
          }
          const row = service.get(flow_id);
          const timeout = Math.min(timeout_ms ?? 600000, 1800000);
          const cmd = workdir ? `cd ${workdir} && ${command}` : command;
          // Inject the host repo bound to the office (agent_flows.home_repo_path)
          // as env (KERNEL_HOME_REPO) so extension scripts don't hardcode it.
          const homeRepo = service.homeRepoPath(flow_id);
          const execArgs = ["exec"];
          if (homeRepo) execArgs.push("-e", `KERNEL_HOME_REPO=${homeRepo}`);
          execArgs.push(row.container_name, "sh", "-c", cmd);
          const { stdout, stderr } = await execFileAsync(
            "docker", execArgs,
            { timeout, maxBuffer: 4 * 1024 * 1024 },
          );
          const out = (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).slice(-6000);
          return textResult("## office-exec output\n```\n" + out + "\n```");
        } catch (e) {
          return errorResult(`office-exec failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    }),
    verb("kernel_office_env_up", "Create + start an office's virtual environment.", (f) => service.up(f)),
    verb("kernel_office_env_pause", "Pause an office's virtual environment.", (f) => service.pause(f)),
    verb("kernel_office_env_resume", "Resume a paused office environment.", (f) => service.resume(f)),
    verb("kernel_office_env_stop", "Stop (shut down) an office's virtual environment (restartable).", (f) => service.stop(f)),
    verb("kernel_office_env_restart", "Restart an office's virtual environment.", (f) => service.restart(f)),
  ];
}

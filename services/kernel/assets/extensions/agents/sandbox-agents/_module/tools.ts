import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { SandboxAgentService } from "./service.js";

export function sandboxAgentTools(service: SandboxAgentService): ToolDefinition[] {
  return [
    {
      name: "kernel_sandbox_agents_list",
      description: "List all discovered sandbox agents and their current status.",
      inputSchema: z.object({}),
      handler: async () => {
        const states = service.listStates();

        if (states.length === 0) {
          return textResult(
            `No sandbox agents found.\n\nPlace agents in: ${service.getAgentsDir()}/\n` +
            `Each agent needs a manifest.json + entry point (default: index.ts).`,
          );
        }

        const lines = states.map((s) => {
          const icon =
            s.status === "ready" ? "🟢" :
            s.status === "starting" ? "🟡" :
            s.status === "error" ? "🔴" : "⚫";
          const pid = s.pid ? ` (pid=${s.pid})` : "";
          const restarts = s.restarts > 0 ? ` restarts=${s.restarts}` : "";
          const err = s.lastError ? `\n  Error: ${s.lastError}` : "";
          return `${icon} **${s.name}** — ${s.status}${pid}${restarts}${err}`;
        });

        return textResult(`Sandbox Agents (${states.length}):\n\n${lines.join("\n")}`);
      },
    },

    {
      name: "kernel_sandbox_agents_start",
      description: "Start a sandbox agent subprocess.",
      inputSchema: z.object({
        name: z.string().describe("Agent name (as declared in manifest.json)"),
      }),
      handler: async (args) => {
        const { name } = args as { name: string };
        const ok = await service.startAgent(name);
        if (!ok) return errorResult(`Agent not found: ${name}`);
        return textResult(`Agent "${name}" started.`);
      },
    },

    {
      name: "kernel_sandbox_agents_stop",
      description: "Stop a running sandbox agent subprocess.",
      inputSchema: z.object({
        name: z.string().describe("Agent name"),
      }),
      handler: async (args) => {
        const { name } = args as { name: string };
        const ok = await service.stopAgent(name);
        if (!ok) return errorResult(`Agent not found: ${name}`);
        return textResult(`Agent "${name}" stopped.`);
      },
    },

    {
      name: "kernel_sandbox_agents_status",
      description: "Get the detailed status of a specific sandbox agent.",
      inputSchema: z.object({
        name: z.string().describe("Agent name"),
      }),
      handler: async (args) => {
        const { name } = args as { name: string };
        const state = service.getState(name);

        if (!state) return errorResult(`Agent not found: ${name}`);

        const lines = [
          `Name: ${state.name}`,
          `Status: ${state.status}`,
          `PID: ${state.pid ?? "(not running)"}`,
          `Started at: ${state.startedAt ?? "(never)"}`,
          `Restarts: ${state.restarts}`,
          `Last error: ${state.lastError ?? "(none)"}`,
        ];

        return textResult(lines.join("\n"));
      },
    },
  ];
}

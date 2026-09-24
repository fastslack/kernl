import { z } from "zod";
import { type ToolDefinition, defineTool, defineToolNoInput, textResult, errorResult } from "@kernl/extension-sdk";
import type { SandboxAgentService } from "./service.js";

export function sandboxAgentTools(service: SandboxAgentService): ToolDefinition[] {
  return [
    defineToolNoInput({
      name: "kernel_sandbox_agents_list",
      description: "List all discovered sandbox agents and their current status.",
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
    }),

    defineTool({
      name: "kernel_sandbox_agents_start",
      description: "Start a sandbox agent subprocess.",
      schema: z.object({
        name: z.string().describe("Agent name (as declared in manifest.json)"),
      }),
      handler: async ({ name }) => {
        const ok = await service.startAgent(name);
        if (!ok) return errorResult(`Agent not found: ${name}`);
        return textResult(`Agent "${name}" started.`);
      },
    }),

    defineTool({
      name: "kernel_sandbox_agents_stop",
      description: "Stop a running sandbox agent subprocess.",
      schema: z.object({
        name: z.string().describe("Agent name"),
      }),
      handler: async ({ name }) => {
        const ok = await service.stopAgent(name);
        if (!ok) return errorResult(`Agent not found: ${name}`);
        return textResult(`Agent "${name}" stopped.`);
      },
    }),

    defineTool({
      name: "kernel_sandbox_agents_status",
      description: "Get the detailed status of a specific sandbox agent.",
      schema: z.object({
        name: z.string().describe("Agent name"),
      }),
      handler: async ({ name }) => {
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
    }),
  ];
}

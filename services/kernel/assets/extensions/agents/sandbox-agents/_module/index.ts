import { join } from "node:path";
import { type KernelModule, type ToolDefinition, defineModule, log } from "@kernl/extension-sdk";
import { SandboxAgentService } from "./service.js";
import { sandboxAgentTools } from "./tools.js";

export interface SandboxAgentsModule extends KernelModule {
  getService(): SandboxAgentService | null;
  /**
   * Call after registry.initializeAll() + all tools are collected.
   * This wires up the kernel tools into each sandbox and auto-starts agents.
   */
  initializeSandboxes(allKernelTools: ToolDefinition[]): Promise<void>;
  /** Agent-contributed tools — available only after initializeSandboxes() */
  getAgentTools(): ToolDefinition[];
}

export function createSandboxAgentsModule(): SandboxAgentsModule {
  let agentTools: ToolDefinition[] = [];
  let service: SandboxAgentService | null = null;

  return {
    ...defineModule({
      name: "sandbox-agents",
      init() {
        const agentsDir = join(process.cwd(), "assets", "agents");
        service = new SandboxAgentService(agentsDir);
        // Note: sandboxes are NOT started here — we wait for initializeSandboxes()
        // which is called in bootstrap() after all tools are collected.
        log.info(`[sandbox-agents] Module initialized. Agents dir: ${agentsDir}`);
        return service;
      },
      tools: sandboxAgentTools,
      shutdown: (svc) => svc.stopAll(),
    }),

    async initializeSandboxes(allKernelTools: ToolDefinition[]): Promise<void> {
      if (!service) return;
      await service.initialize(allKernelTools);
      agentTools = service.buildAgentTools();
      if (agentTools.length > 0) {
        log.info(`[sandbox-agents] ${agentTools.length} agent tool(s) registered`);
      }
    },

    getAgentTools() {
      return agentTools;
    },

    getService() {
      return service;
    },
  };
}

import { log } from "../../../../../src/core/logger.js";
import { z } from "zod";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import { AgentLoader } from "./loader.js";
import { AgentSandbox } from "./sandbox.js";
import { buildPermittedTools } from "./permissions.js";
import type { AgentDescriptor, SandboxState } from "./types.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";

/**
 * SandboxAgentService
 *
 * Orchestrates the full lifecycle of sandbox agents:
 *  1. Discover agents via AgentLoader
 *  2. Build an AgentSandbox for each descriptor
 *  3. Filter kernel tools per-agent permissions
 *  4. Auto-start agents marked autoStart=true
 *  5. Expose agent-contributed tools to the kernel registry
 */
export class SandboxAgentService {
  private sandboxes = new Map<string, AgentSandbox>();
  private descriptors = new Map<string, AgentDescriptor>();
  private loader: AgentLoader;

  constructor(
    /** Absolute path to the agents root directory (e.g. process.cwd() + "/agents") */
    private agentsDir: string,
  ) {
    this.loader = new AgentLoader(agentsDir);
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  /**
   * Discover all agents, inject kernel tools, optionally auto-start.
   * Call this after all kernel tools are registered.
   */
  async initialize(allKernelTools: ToolDefinition[]): Promise<void> {
    const descriptors = await this.loader.discover();

    for (const desc of descriptors) {
      this.descriptors.set(desc.manifest.name, desc);

      const sandbox = new AgentSandbox(desc);
      const permitted = buildPermittedTools(allKernelTools, desc.manifest);
      sandbox.setKernelTools(permitted);
      this.sandboxes.set(desc.manifest.name, sandbox);

      if (desc.manifest.autoStart) {
        try {
          await sandbox.start();
        } catch (err) {
          log.error(`[SandboxAgentService] Failed to auto-start "${desc.manifest.name}": ${err}`);
        }
      }
    }

    log.info(
      `[SandboxAgentService] ${this.sandboxes.size} sandbox agent(s) initialized`,
    );
  }

  // ── Tool generation ────────────────────────────────────────────────────────

  /**
   * Build ToolDefinitions from all agents' declared tools.
   * Each agent tool becomes: kernel_sandboxagent_<agentName>_<toolName>
   */
  buildAgentTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    for (const [name, sandbox] of this.sandboxes) {
      for (const toolDef of sandbox.manifest.tools) {
        const fullName = `kernel_sandboxagent_${name.replace(/-/g, "_")}_${toolDef.name}`;

        // Build a Zod schema from the raw JSON schema object stored in manifest
        // We use z.unknown() as a passthrough — real validation happens inside agent
        const inputSchema = z.record(z.unknown()).default({});

        tools.push({
          name: fullName,
          description: `[${sandbox.manifest.displayName}] ${toolDef.description}`,
          inputSchema,
          handler: async (args: unknown) => {
            try {
              const result = await sandbox.call(toolDef.name, args);
              // Agent should return { content: [...] } matching ToolResult shape
              if (
                result &&
                typeof result === "object" &&
                "content" in (result as object)
              ) {
                return result as ReturnType<typeof textResult>;
              }
              // Wrap plain string results
              return textResult(typeof result === "string" ? result : JSON.stringify(result));
            } catch (err) {
              return errorResult(String(err));
            }
          },
        });
      }
    }

    return tools;
  }

  // ── Control ────────────────────────────────────────────────────────────────

  async startAgent(name: string): Promise<boolean> {
    const sandbox = this.sandboxes.get(name);
    if (!sandbox) return false;
    await sandbox.start();
    return true;
  }

  async stopAgent(name: string): Promise<boolean> {
    const sandbox = this.sandboxes.get(name);
    if (!sandbox) return false;
    await sandbox.stop();
    return true;
  }

  async stopAll(): Promise<void> {
    for (const sandbox of this.sandboxes.values()) {
      try {
        await sandbox.stop();
      } catch (err) {
        log.warn(`[SandboxAgentService] Error stopping "${sandbox.name}": ${err}`);
      }
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  listStates(): SandboxState[] {
    return [...this.sandboxes.values()].map((s) => s.getState());
  }

  getState(name: string): SandboxState | undefined {
    return this.sandboxes.get(name)?.getState();
  }

  getAgentsDir(): string {
    return this.agentsDir;
  }
}

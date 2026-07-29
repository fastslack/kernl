import type { MarketplaceService } from "../service.js";
import type { AgentPackage } from "../types.js";
import { log } from "../../../core/logger.js";

interface AgentServiceLike {
  createAgent(input: {
    name: string;
    description?: string;
    system_prompt?: string;
    goal_template?: string;
    allowed_tools?: string[];
    denied_tools?: string[];
    provider?: string;
    model?: string;
    max_iterations?: number;
    timeout_ms?: number;
    variables?: Record<string, string>;
  }): { id: string };
  addLearning?(input: {
    agent_id: string;
    type: string;
    content: string;
    confidence?: number;
  }): unknown;
  addEventTrigger?(input: {
    agent_id: string;
    event_name: string;
    filter?: Record<string, unknown>;
    cooldown_ms?: number;
  }): unknown;
}

/**
 * Install an agent package — creates agent row + learnings + triggers.
 */
export function installAgent(
  service: MarketplaceService,
  agentService: AgentServiceLike,
  itemId: string,
): string | null {
  try {
    const item = service.getItem(itemId);
    if (!item || item.type !== "agent") return null;

    const pkg = JSON.parse(item.package_data) as AgentPackage;
    if (!pkg.agent) return null;

    const agent = agentService.createAgent({
      name: pkg.name ?? item.name,
      description: pkg.description ?? item.description,
      system_prompt: pkg.agent.system_prompt,
      goal_template: pkg.agent.goal_template,
      allowed_tools: pkg.agent.allowed_tools,
      denied_tools: pkg.agent.denied_tools,
      provider: pkg.agent.provider,
      model: pkg.agent.model,
      max_iterations: pkg.agent.max_iterations,
      timeout_ms: pkg.agent.timeout_ms,
      variables: pkg.agent.variables,
    });

    // Add learnings
    if (pkg.learnings && agentService.addLearning) {
      for (const l of pkg.learnings) {
        agentService.addLearning({
          agent_id: agent.id,
          type: l.type,
          content: l.content,
          confidence: l.confidence,
        });
      }
    }

    // Add triggers
    if (pkg.triggers && agentService.addEventTrigger) {
      for (const t of pkg.triggers) {
        agentService.addEventTrigger({
          agent_id: agent.id,
          event_name: t.event_name,
          filter: t.filter,
          cooldown_ms: t.cooldown_ms,
        });
      }
    }

    service.installItem(itemId);
    log.info(`Marketplace: installed agent "${item.name}" → agent ID ${agent.id}`);
    return agent.id;
  } catch (err) {
    log.error("Agent installation failed", err);
    return null;
  }
}

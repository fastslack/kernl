import type { MarketplaceService } from "../service.js";
import type { FlowPackage } from "../types.js";
import { log } from "../../../core/logger.js";

interface AgentServiceLike {
  createFlow(input: { name: string; description?: string; color?: string }): { id: string };
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
    flow_id?: string;
    variables?: Record<string, string>;
  }): { id: string };
  addChain(input: {
    source_agent_id: string;
    target_agent_id: string;
    label?: string;
    condition?: Record<string, unknown>;
    pass_result?: boolean;
    delay_ms?: number;
  }): unknown;
}

/**
 * Install a flow package — creates flow + agents + chains, maps ref IDs to real UUIDs.
 */
export function installFlow(
  service: MarketplaceService,
  agentService: AgentServiceLike,
  itemId: string,
): string | null {
  try {
    const item = service.getItem(itemId);
    if (!item || item.type !== "flow") return null;

    const pkg = JSON.parse(item.package_data) as FlowPackage;
    if (!pkg.flow || !pkg.agents) return null;

    // 1. Create flow
    const flow = agentService.createFlow({
      name: pkg.flow.name ?? item.name,
      description: pkg.flow.description ?? item.description,
      color: pkg.flow.color,
    });

    // 2. Create agents, build refId → realId mapping
    const refMap = new Map<string, string>();
    for (const [refId, agentDef] of Object.entries(pkg.agents)) {
      const agent = agentService.createAgent({
        name: agentDef.name,
        description: agentDef.description,
        system_prompt: agentDef.system_prompt,
        goal_template: agentDef.goal_template,
        allowed_tools: agentDef.allowed_tools,
        denied_tools: agentDef.denied_tools,
        provider: agentDef.provider,
        model: agentDef.model,
        max_iterations: agentDef.max_iterations,
        timeout_ms: agentDef.timeout_ms,
        flow_id: flow.id,
        variables: agentDef.variables,
      });
      refMap.set(refId, agent.id);
    }

    // 3. Create chains, resolving refs
    if (pkg.chains) {
      for (const chainDef of pkg.chains) {
        const sourceId = refMap.get(chainDef.source_ref);
        const targetId = refMap.get(chainDef.target_ref);
        if (!sourceId || !targetId) {
          log.warn(`Marketplace flow install: skipping chain — unresolved ref ${chainDef.source_ref} → ${chainDef.target_ref}`);
          continue;
        }
        agentService.addChain({
          source_agent_id: sourceId,
          target_agent_id: targetId,
          label: chainDef.label,
          condition: chainDef.condition,
          pass_result: chainDef.pass_result,
          delay_ms: chainDef.delay_ms,
        });
      }
    }

    service.installItem(itemId);
    log.info(`Marketplace: installed flow "${item.name}" → flow ID ${flow.id} (${refMap.size} agents)`);
    return flow.id;
  } catch (err) {
    log.error("Flow installation failed", err);
    return null;
  }
}

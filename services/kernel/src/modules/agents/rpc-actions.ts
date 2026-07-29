/**
 * Agents RPC Actions — lightweight actions via mtwRequest for the Agent Composer.
 */

import type { RpcAction } from "../../core/mtw/rpc-handler.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import type { EventBus } from "../../core/event-bus.js";
import {
  officeDefinitionFromJson,
  materializeOffice,
  loadRepoServiceBestEffort,
} from "./office-kit.js";

export interface AgentsRpcDeps {
  service: AgentService | null;
  executor?: AgentExecutor | null;
  events?: EventBus | null;
}

export function agentsRpcActions(deps: AgentsRpcDeps): RpcAction[] {
  const { service, executor, events } = deps;

  function requireService(): AgentService {
    if (!service) throw new Error("Agent service not available");
    return service;
  }

  return [
    {
      name: "agents.create",
      handler: async (args) => {
        const svc = requireService();
        const name = typeof args.name === "string" ? args.name : "";
        if (!name) throw new Error("name is required");
        const agent = svc.createAgent({
          name,
          description: typeof args.description === "string" ? args.description : undefined,
          system_prompt: typeof args.system_prompt === "string" ? args.system_prompt : undefined,
          goal_template: typeof args.goal_template === "string" ? args.goal_template : undefined,
          allowed_tools: Array.isArray(args.allowed_tools) ? args.allowed_tools as string[] : undefined,
          denied_tools: Array.isArray(args.denied_tools) ? args.denied_tools as string[] : undefined,
          provider: typeof args.provider === "string" ? args.provider : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
          max_iterations: typeof args.max_iterations === "number" ? args.max_iterations : undefined,
          timeout_ms: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          show_on_dashboard: typeof args.show_on_dashboard === "boolean" ? args.show_on_dashboard : undefined,
          flow_id: typeof args.flow_id === "string" ? args.flow_id : undefined,
          variables: typeof args.variables === "object" && args.variables ? args.variables as Record<string, string> : undefined,
          max_tokens: typeof args.max_tokens === "number" ? args.max_tokens : undefined,
          max_errors: typeof args.max_errors === "number" ? args.max_errors : undefined,
        });
        return { success: true, agent_id: agent.id, agent };
      },
    },
    {
      name: "agents.update",
      handler: async (args) => {
        const svc = requireService();
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("id required");
        const updated = svc.updateAgent(id, {
          name: typeof args.name === "string" ? args.name : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          system_prompt: typeof args.system_prompt === "string" ? args.system_prompt : undefined,
          goal_template: typeof args.goal_template === "string" ? args.goal_template : undefined,
          allowed_tools: Array.isArray(args.allowed_tools) ? args.allowed_tools as string[] : undefined,
          denied_tools: Array.isArray(args.denied_tools) ? args.denied_tools as string[] : undefined,
          provider: typeof args.provider === "string" ? args.provider : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
          max_iterations: typeof args.max_iterations === "number" ? args.max_iterations : undefined,
          timeout_ms: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          active: typeof args.active === "boolean" ? args.active : undefined,
          max_tokens: typeof args.max_tokens === "number" ? args.max_tokens : undefined,
          max_errors: typeof args.max_errors === "number" ? args.max_errors : undefined,
          variables: typeof args.variables === "object" && args.variables ? args.variables as Record<string, string> : undefined,
          builtin_handler: typeof args.builtin_handler === "string" ? args.builtin_handler : undefined,
        });
        if (!updated) throw new Error("Agent not found");
        return { success: true, agent: updated };
      },
    },
    {
      name: "agents.delete",
      handler: async (args) => {
        const svc = requireService();
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("id required");
        const ok = svc.deleteAgent(id);
        if (!ok) throw new Error("Agent not found");
        return { success: true };
      },
    },
    {
      name: "agents.detail",
      handler: async (args) => {
        const svc = requireService();
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("id required");
        const agent = svc.getAgent(id);
        if (!agent) throw new Error("Agent not found");
        const runs = svc.listRuns({ agent_id: id, limit: 5 });
        return { agent, runs };
      },
    },
    {
      name: "agents.run",
      handler: async (args) => {
        const svc = requireService();
        if (!executor) throw new Error("Agent executor not available");
        const agent_id = typeof args.agent_id === "string" ? args.agent_id : "";
        if (!agent_id) throw new Error("agent_id required");
        const agent = svc.getAgent(agent_id);
        if (!agent) throw new Error("Agent not found");

        const goal = (typeof args.goal === "string" && args.goal) || agent.goal_template || `Execute the agent: ${agent.name}`;
        const run = svc.createRun({ agent_id: agent.id, trigger_type: "manual", goal });
        svc.updateRun(run.id, { status: "running", started_at: new Date().toISOString() });

        // Run async -- don't await
        executor.execute({ agent, goal, run, service: svc, events: events ?? undefined }).then(result => {
          svc.updateRun(run.id, {
            status: result.status,
            result: result.result,
            error: result.error,
            steps_count: result.steps_count,
            tokens_used: result.tokens_used,
            completed_at: new Date().toISOString(),
          });
        }).catch(err => {
          svc.updateRun(run.id, { status: "failed", error: String(err), completed_at: new Date().toISOString() });
        });

        return { success: true, run_id: run.id, status: "running" };
      },
    },
    {
      name: "agents.stop",
      handler: async (args) => {
        const svc = requireService();
        if (!executor) throw new Error("Agent executor not available");

        if (typeof args.run_id === "string" && args.run_id) {
          const cancelled = executor.cancelRun(args.run_id);
          if (cancelled) {
            svc.updateRun(args.run_id, { status: "cancelled", completed_at: new Date().toISOString() });
          }
          return { success: true, cancelled: cancelled ? 1 : 0 };
        }

        if (typeof args.agent_id === "string" && args.agent_id) {
          const runs = svc.listRuns({ agent_id: args.agent_id, status: "running" });
          let cancelled = 0;
          for (const run of runs) {
            if (executor.cancelRun(run.id)) {
              svc.updateRun(run.id, { status: "cancelled", completed_at: new Date().toISOString() });
              cancelled++;
            }
          }
          return { success: true, cancelled };
        }

        throw new Error("agent_id or run_id required");
      },
    },
    {
      name: "agents.trigger",
      handler: async (args) => {
        const svc = requireService();
        const agent_id = typeof args.agent_id === "string" ? args.agent_id : "";
        if (!agent_id) throw new Error("agent_id required");
        const type = typeof args.type === "string" ? args.type : "";
        if (!type) throw new Error("type required (event|schedule)");

        if (type === "event") {
          const event_name = typeof args.event_name === "string" ? args.event_name : "";
          if (!event_name) throw new Error("event_name required for event trigger");
          const trigger = svc.addEventTrigger({
            agent_id,
            event_name,
            filter: typeof args.filter === "object" && args.filter ? args.filter as Record<string, unknown> : undefined,
            cooldown_ms: typeof args.cooldown_ms === "number" ? args.cooldown_ms : undefined,
          });
          return { success: true, trigger_id: trigger.id };
        }

        if (type === "schedule") {
          const cron = typeof args.cron === "string" ? args.cron : undefined;
          const interval_ms = typeof args.interval_ms === "number" ? args.interval_ms : undefined;
          if (!cron && (!interval_ms || interval_ms < 60000)) {
            throw new Error("cron expression or interval_ms (>= 60000) required");
          }
          const schedule = svc.addSchedule({
            agent_id,
            interval_ms,
            cron_expression: cron,
            goal_override: typeof args.goal_override === "string" ? args.goal_override : undefined,
          });
          return { success: true, schedule_id: schedule.id, schedule };
        }

        throw new Error("type must be event or schedule");
      },
    },
    {
      name: "agents.chain.create",
      handler: async (args) => {
        const svc = requireService();
        const source_agent_id = typeof args.source_agent_id === "string" ? args.source_agent_id : "";
        const target_agent_id = typeof args.target_agent_id === "string" ? args.target_agent_id : "";
        if (!source_agent_id || !target_agent_id) throw new Error("source_agent_id and target_agent_id required");
        const chain = svc.addChain({
          source_agent_id,
          target_agent_id,
          label: typeof args.label === "string" ? args.label : undefined,
          condition: typeof args.condition === "object" && args.condition ? args.condition as Record<string, unknown> : undefined,
          pass_result: typeof args.pass_result === "boolean" ? args.pass_result : undefined,
          delay_ms: typeof args.delay_ms === "number" ? args.delay_ms : undefined,
        });
        return { success: true, chain_id: chain.id, chain };
      },
    },
    {
      name: "agents.chain.delete",
      handler: async (args) => {
        const svc = requireService();
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("id required");
        const ok = svc.removeChain(id);
        if (!ok) throw new Error("Chain not found");
        return { success: true };
      },
    },
    {
      name: "agents.eventLog.list",
      handler: async (args) => {
        const svc = requireService();
        const limit = typeof args.limit === "number" ? Math.min(args.limit, 500) : 200;
        const offset = typeof args.offset === "number" ? args.offset : 0;
        const events_list = svc.getEventLog({
          run_id: typeof args.run_id === "string" ? args.run_id : undefined,
          agent_id: typeof args.agent_id === "string" ? args.agent_id : undefined,
          event_type: typeof args.event_type === "string" ? args.event_type : undefined,
          since: typeof args.since === "string" ? args.since : undefined,
          limit,
          offset,
        });
        const total = svc.getEventLogCount({
          run_id: typeof args.run_id === "string" ? args.run_id : undefined,
          agent_id: typeof args.agent_id === "string" ? args.agent_id : undefined,
          event_type: typeof args.event_type === "string" ? args.event_type : undefined,
          since: typeof args.since === "string" ? args.since : undefined,
        });
        return { events: events_list, total };
      },
    },
    {
      name: "agents.eventLog.clear",
      handler: async (args) => {
        const svc = requireService();
        const deleted = svc.clearEventLog({
          before: typeof args.before === "string" ? args.before : undefined,
          agent_id: typeof args.agent_id === "string" ? args.agent_id : undefined,
        });
        return { success: true, deleted };
      },
    },
    {
      name: "agents.graph",
      handler: async (args) => {
        const svc = requireService();
        const flowId = typeof args.flow_id === "string" ? args.flow_id : undefined;
        const graph = svc.getAgentGraph(flowId);
        return graph;
      },
    },
    {
      name: "agents.flows.list",
      handler: async () => {
        const svc = requireService();
        const flows = svc.listFlows();
        return { flows };
      },
    },
    {
      name: "agents.flows.create",
      handler: async (args) => {
        const svc = requireService();
        const name = typeof args.name === "string" ? args.name : "";
        if (!name) throw new Error("name is required");
        const flow = svc.createFlow({
          name,
          description: typeof args.description === "string" ? args.description : undefined,
          color: typeof args.color === "string" ? args.color : undefined,
        });
        // Optionally assign agents
        if (Array.isArray(args.agent_ids)) {
          for (const aid of args.agent_ids as string[]) {
            svc.assignAgentToFlow(aid, flow.id);
          }
        }
        return { success: true, flow };
      },
    },
    {
      // Office Kit — one call creates/refreshes a whole office: flow + agents
      // (+ chains + cron + repo). Consumed by the "New Office" wizard on
      // /agents-flow. Same engine as `kernel_office_create` and the CLI
      // (scripts/seed-office.ts). Idempotent.
      name: "offices.create",
      handler: async (args) => {
        const svc = requireService();
        const def = officeDefinitionFromJson(args);
        const db = svc.getDb();
        const repoService = def.repo ? await loadRepoServiceBestEffort(db) : null;
        const report = materializeOffice(db, svc, def, { repoService });
        return { success: true, report };
      },
    },
    {
      name: "agents.flows.delete",
      handler: async (args) => {
        const svc = requireService();
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("id required");
        const ok = svc.deleteFlow(id);
        if (!ok) throw new Error("Flow not found");
        return { success: true };
      },
    },
    {
      name: "agents.flows.assign",
      handler: async (args) => {
        const svc = requireService();
        const flow_id = typeof args.flow_id === "string" ? args.flow_id : "";
        if (!flow_id) throw new Error("flow_id required");
        const agent_ids = Array.isArray(args.agent_ids) ? args.agent_ids as string[] : [];
        if (!agent_ids.length) throw new Error("agent_ids required");
        for (const aid of agent_ids) {
          svc.assignAgentToFlow(aid, flow_id);
        }
        return { success: true, assigned: agent_ids.length };
      },
    },
    {
      name: "agents.runs.detail",
      handler: async (args) => {
        const svc = requireService();
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("id required");
        const run = svc.getRun(id);
        if (!run) throw new Error("Run not found");
        const steps = svc.getSteps(id);
        const events = svc.getRunEvents(id);
        const agent = svc.getAgent(run.agent_id);
        return { run, steps, events, agent_name: agent?.name ?? "Unknown" };
      },
    },
  ];
}

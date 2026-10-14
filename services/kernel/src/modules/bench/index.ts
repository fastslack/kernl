/**
 * Model Bench — compares every configured model on Kernl's own kinds of work
 * (tool calling, agent tasks, JSON, numbers, language, long context, prompt
 * injection) with deterministic checks, and shows it on /bench.
 *
 * The targets are the connected providers, each with its configured model.
 * Adapters come from the same factory the chat and the agents use, wrapped
 * by instrumentProvider, so every bench call lands in the call log and in
 * llm_usage_daily under caller "bench:<task>".
 */

import type { ExtensibleModule, ModuleContext, ToolDefinition, DashboardDescriptor } from "../../core/types.js";
import type { RpcAction } from "../../core/mtw/rpc-handler.js";
import { runMigrations } from "../../core/db/migrations.js";
import { buildChatAdapter } from "../../core/llm/chat-factory.js";
import { instrumentProvider } from "../../core/llm/chat-instrumentation.js";
import { getCatalogEntry } from "../../core/llm/provider-catalog.js";
import { getProviderConfig, listConnected } from "../../core/llm/credentials.js";
import { estimateCostUsd } from "../../core/llm/call-log.js";
import { benchMigrations } from "./migrations.js";
import { BenchService } from "./service.js";
import type { BenchTarget } from "./runner.js";

export function createBenchModule(): ExtensibleModule {
  let service: BenchService | null = null;
  const need = () => {
    if (!service) throw new Error("The bench is not ready yet.");
    return service;
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  return {
    name: "bench",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "bench", benchMigrations);
      const targets = (): BenchTarget[] => {
        const out: BenchTarget[] = [];
        for (const slug of listConnected()) {
          const entry = getCatalogEntry(slug);
          if (!entry) continue;
          const model = getProviderConfig(entry.slug).model || entry.models?.recommended || "";
          const adapter = buildChatAdapter(entry.slug, {}, { claudeCode: ctx.config.claudeCode, defaultModel: ctx.config.chat?.defaultModel });
          if (!adapter || !adapter.available() || !model) continue;
          out.push({ slug: entry.slug, name: entry.name, model, provider: instrumentProvider(adapter), supportsTools: adapter.supportsToolLoop !== false });
        }
        return out;
      };
      service = new BenchService(ctx.sqlite, {
        targets,
        // Reported cost wins (the runner only asks when none came back); then the
        // stored price; then a free or local provider costs nothing; else unknown.
        estimateCost: (slug, model, i, o) => {
          const est = estimateCostUsd(slug, model, i, o);
          if (est !== null) return est;
          const group = getCatalogEntry(slug)?.group;
          return group === "free" || group === "local" ? 0 : null;
        },
      });
    },
    getTools(): ToolDefinition[] { return []; },
    getRpcActions(): RpcAction[] {
      return [
        { name: "bench.overview", handler: async () => need().overview() },
        { name: "bench.status", handler: async () => need().status() },
        { name: "bench.start", handler: async () => need().start() },
        { name: "bench.cancel", handler: async () => need().cancel() },
        { name: "bench.run", handler: async (a) => need().report(str(a.id)) },
        { name: "bench.attempts", handler: async (a) => need().attempts(str(a.run), str(a.task), str(a.slug), str(a.model)) },
        { name: "bench.delete", handler: async (a) => need().deleteRun(str(a.id)) },
      ];
    },
    getDashboardDescriptor(): DashboardDescriptor {
      return { nav: [{ id: "bench", label: "Bench", icon: "🏁", group: "ai", order: 24 }] };
    },
    async shutdown() {},
  };
}

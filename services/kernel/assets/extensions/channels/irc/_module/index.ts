import { resolve } from "node:path";
import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { log } from "../../../../../src/core/logger.js";
import { ircMigrations } from "./migrations/001_irc.js";
import { IrcStore } from "./store.js";
import { SaslAuthenticator } from "./security/sasl.js";
import { IrcServer } from "./server/ircd.js";
import { IrcProvider, type IrcRuntimeConfig } from "./irc-provider.js";
import { OfficeBridge, type OfficeAgentSource, type OfficeDescriptor, type OfficeReply } from "./bridge/office-bridge.js";
import { ChannelBridge, type RegistryLike } from "./bridge/channel-bridge.js";
import { ircTools } from "./tools.js";

/** Structural view of the agents module (core) we duck-type at runtime. */
interface AgentsModuleLike {
  getService(): {
    listFlows(): { id: string; name: string; active: number }[];
    listAgents(filters?: { active?: boolean }): { id: string; name: string; flow_id: string; role?: string }[];
    createRun(opts: { agent_id: string; trigger_type: string; goal: string }): { id: string };
    updateRun(id: string, patch: Record<string, unknown>): void;
  } | null;
  getExecutor(): {
    execute(opts: {
      agent: unknown;
      goal: string;
      run: unknown;
      service: unknown;
      events?: unknown;
    }): Promise<{ status: string; result?: string; error?: string }>;
  } | null;
}

const DIACRITICS = /[̀-ͯ]/g;

function ircSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(DIACRITICS, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "office"
  );
}

function ircNick(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(DIACRITICS, "")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .replace(/^[^A-Za-z]+/, "")
      .slice(0, 28) || "agent"
  );
}

/** Build an OfficeAgentSource backed by the kernel agents module (graceful stub if absent). */
function buildOfficeSource(ctx: ModuleContext): OfficeAgentSource {
  const mod = ctx.getModule?.("agents") as unknown as AgentsModuleLike | null;
  const service = mod?.getService?.() ?? null;
  const executor = mod?.getExecutor?.() ?? null;

  if (!service) {
    return {
      listOffices: () => [],
      runOffice: async () => [{ agentNick: "kernel", text: "⚠️ Agents module not available." }],
    };
  }

  return {
    listOffices(): OfficeDescriptor[] {
      const flows = service.listFlows().filter((f) => f.active === 1);
      const agents = service.listAgents({ active: true });
      return flows.map((f) => ({
        flowId: f.id,
        name: f.name,
        slug: ircSlug(f.name),
        agents: agents
          .filter((a) => a.flow_id === f.id)
          .map((a) => ({ nick: ircNick(a.name), account: a.id, realname: a.name })),
      }));
    },
    async runOffice({ flowId, text, fromNick }): Promise<OfficeReply[]> {
      if (!executor) return [{ agentNick: "kernel", text: "⚠️ Agent executor not wired." }];
      const agents = service.listAgents({ active: true }).filter((a) => a.flow_id === flowId);
      if (agents.length === 0) return [{ agentNick: "kernel", text: "No agents in this office." }];
      // Run the office's manager (or the first agent) with the user's message.
      const lead = agents.find((a) => a.role === "manager") ?? agents[0];
      const run = service.createRun({ agent_id: lead.id, trigger_type: "manual", goal: `[IRC from ${fromNick}] ${text}` });
      service.updateRun(run.id, { status: "running", started_at: new Date().toISOString() });
      try {
        const res = await executor.execute({ agent: lead, goal: `[IRC from ${fromNick}] ${text}`, run, service, events: ctx.events });
        service.updateRun(run.id, { status: res.status, result: res.result, error: res.error, completed_at: new Date().toISOString() });
        return [{ agentNick: ircNick(lead.name), text: res.status === "completed" ? res.result || "(no output)" : `❌ ${res.error ?? "run failed"}` }];
      } catch (err) {
        service.updateRun(run.id, { status: "failed", error: String(err), completed_at: new Date().toISOString() });
        return [{ agentNick: ircNick(lead.name), text: `❌ ${err instanceof Error ? err.message : err}` }];
      }
    },
  };
}

export function createIrcModule(): KernelModule {
  let tools: ToolDefinition[] = [];
  let provider: IrcProvider | null = null;

  return {
    name: "ext:irc",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "irc", ircMigrations);

      const store = new IrcStore(ctx.sqlite);
      const sasl = new SaslAuthenticator(store, {});

      const runtime: IrcRuntimeConfig = {
        tlsPort: 6697,
        wsPath: "/ws/irc",
        serverName: "irc.kernl",
        networkName: "Kernl",
        botNick: "kernel",
        motd: "Welcome to the Kernl IRC network.",
        // Default OFF so a fresh activation is testable immediately (TLS is
        // still mandatory). Turn on + set saslPassword (or wire the vault
        // verifier) / requireClientCert for production hardening.
        requireSasl: false,
        requireClientCert: false,
        historyLimit: 200,
        dataDir: resolve(process.cwd(), "data/irc"),
      };

      // IrcRuntimeConfig structurally satisfies IrcServerConfig.
      const server = new IrcServer(runtime, store, sasl);

      const officeBridge = new OfficeBridge(server, buildOfficeSource(ctx));
      const registry = ctx.notifier.getRegistry() as unknown as RegistryLike;
      const channelBridge = new ChannelBridge(server, registry);

      provider = new IrcProvider({ server, cfg: runtime, officeBridge, channelBridge, sasl });
      ctx.notifier.getRegistry().registerFactory("irc", () => provider!);

      tools = ircTools({ server, store, channelBridge, officeBridge });
      log.info("IRC: module initialized (provider registered, awaiting activation)");
    },
    getTools(): ToolDefinition[] {
      return tools;
    },
    async shutdown() {
      await provider?.stop();
    },
  };
}

export { IrcProvider };

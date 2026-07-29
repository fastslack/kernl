#!/usr/bin/env bun
/**
 * Demo: progressive tool discovery in the native agent executor.
 *
 *   bun scripts/demo-progressive-discovery.ts
 *
 * Exercises `resolveTools` for two agents — one with progressive_discovery=0
 * (legacy: every allowed tool sent every turn) and one with =1 (bootstrap
 * only; the model uses the meta tools — kernel_tool_search /
 * kernel_tool_describe / kernel_tool_activate / kernel_code_run — to grow
 * the active set on demand).
 *
 * Then drives a stubbed `runToolLoop` to prove that calling
 * `kernel_tool_activate` mutates the live llmTools array in place — the
 * next iteration sees the newly activated tool with no plumbing in the
 * loop itself. (And kernel_code_run sits in the bootstrap so PD agents can
 * also compose multiple calls in one inference round, à la David Soria
 * Parra's "code mode".)
 */
import { Database } from "bun:sqlite";
import { z } from "zod";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { createMetaModule } from "../src/modules/meta/index.js";
import { EventBus } from "../src/core/event-bus.js";
import { textResult } from "../src/core/helpers.js";
import type { ToolDefinition } from "../src/core/types.js";
import type { ChatLlmProvider } from "../src/modules/chat/llm-adapter.js";
import type {
  ChatMessage,
  ChatCompletionResult,
  ChatCompletionOptions,
} from "../src/modules/chat/types.js";

// ── Build a fake catalog covering several "domains" so kernel_tool_search has
//    something realistic to rank against. Each handler is a no-op stub.
function makeFakeCatalog(): ToolDefinition[] {
  const stubHandler = async () => textResult("(stub result)");
  const def = (name: string, description: string, tags: string[] = []): ToolDefinition => ({
    name,
    description,
    inputSchema: z.object({ payload: z.string().optional() }) as z.ZodType<unknown>,
    tags,
    handler: stubHandler,
  });
  return [
    // Social baseline — every agent gets these. They live in the bootstrap.
    def("kernel_agents_directory", "List every agent in the fleet.", ["agents"]),
    def("kernel_agents_memory", "Return the agent's relevant memory.", ["agents"]),
    def("kernel_agents_inbox", "Read inbox messages from colleagues.", ["agents"]),
    def("kernel_agents_post_to_colleague", "Send a message to another agent.", ["agents"]),
    def("kernel_agents_call_meeting", "Open a multi-agent meeting.", ["agents"]),
    def("kernel_agents_invoke", "Synchronously invoke another agent.", ["agents"]),
    def("kernel_agents_subscribe_conversation", "Subscribe to a conversation.", ["agents"]),
    def("kernel_agents_unsubscribe_conversation", "Unsubscribe from a conversation.", ["agents"]),
    def("kernel_agents_list_subscriptions", "List your active subscriptions.", ["agents"]),

    // Workspace publish — also bootstrap.
    def("kernel_workspace_analysis_save", "Publish an analysis to the office workspace.", ["workspace"]),
    def("kernel_workspace_analysis_list", "List recent analyses across offices.", ["workspace"]),
    def("kernel_workspace_search", "Search published analyses by keyword.", ["workspace"]),
    def("kernel_workspace_read", "Read a published analysis by id.", ["workspace"]),

    // Email — discoverable via search.
    def("kernel_comms_send", "Send an email message to one or more recipients.", ["email", "send"]),
    def("kernel_comms_search_inbox", "Search the email inbox for messages.", ["email", "search"]),
    def("kernel_comms_reply", "Reply to an existing email thread.", ["email"]),
    def("kernel_email_analyze", "Analyze inbound emails for triage suggestions.", ["email"]),

    // Calendar
    def("kernel_calendar_create_event", "Create a new calendar event.", ["calendar"]),
    def("kernel_calendar_today", "Return today's calendar events.", ["calendar"]),
    def("kernel_calendar_upcoming", "Return upcoming calendar events.", ["calendar"]),

    // Trading — to prove search is keyword-targeted, not "give me all".
    def("kernel_trading_order", "Place a trading order.", ["trading"]),
    def("kernel_trading_balance", "Return current trading balance.", ["trading"]),
    def("kernel_trading_ticker", "Return the latest ticker for a symbol.", ["trading"]),

    // Files
    def("kernel_files_search", "Search local files by content.", ["files"]),
    def("kernel_fs_list", "List files at a path.", ["files"]),
    def("kernel_fs_stat", "Stat a single path.", ["files"]),
  ];
}

// ── Build the meta tools (search/describe/activate/code_run) using the same
//    factory the kernel uses in production. Wire them into the catalog so
//    setKernelTools(...) sees them — exactly like bootstrap does.
function buildCatalog(): ToolDefinition[] {
  const fake = makeFakeCatalog();
  const meta = createMetaModule({ getCatalog: () => fake.concat(metaSlot ?? []) });
  // The meta module's getCatalog returns *its own* tools too via the slot
  // variable below, so search can find them by name.
  metaSlot = meta.getTools();
  return [...fake, ...metaSlot];
}
let metaSlot: ToolDefinition[] | null = null;

// ── Stub provider — scripts a 4-turn conversation that exercises both flows
//    a PD agent has at its disposal:
//      1. search → activate → call (legacy LLM tool ergonomics)
//      2. code_run (compose multiple calls in one inference)
class StubProvider implements ChatLlmProvider {
  readonly name = "stub";
  toolsPerTurn: { count: number; names: string[] }[] = [];
  private turn = 0;

  available() { return true; }

  async chatCompletion(
    _messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    this.turn++;
    const toolNames = (opts?.tools ?? []).map((t) => t.name);
    this.toolsPerTurn.push({ count: toolNames.length, names: toolNames });

    if (this.turn === 1) {
      // Turn 1: agent realizes it needs an email tool — search.
      return {
        content: "Need email tool. Searching...",
        model: "stub-1",
        tokens_used: 50,
        tool_calls: [{
          type: "tool_use",
          id: "tu_1",
          name: "kernel_tool_search",
          input: { query: "email send", limit: 5 },
        }],
      };
    }
    if (this.turn === 2) {
      // Turn 2: pick one match and activate it as a directly-callable tool.
      return {
        content: "Activating kernel_comms_send.",
        model: "stub-1",
        tokens_used: 40,
        tool_calls: [{
          type: "tool_use",
          id: "tu_2",
          name: "kernel_tool_activate",
          input: { names: ["kernel_comms_send"] },
        }],
      };
    }
    if (this.turn === 3) {
      // Turn 3: now that activate ran, kernel_comms_send must be in the tools list.
      const hasComms = toolNames.includes("kernel_comms_send");
      return {
        content: hasComms
          ? "Found activated kernel_comms_send. Calling it directly."
          : "ERROR: kernel_comms_send was NOT activated.",
        model: "stub-1",
        tokens_used: 50,
        tool_calls: hasComms ? [{
          type: "tool_use",
          id: "tu_3",
          name: "kernel_comms_send",
          input: { payload: "hello world" },
        }] : [],
      };
    }
    // Turn 4: wrap up.
    return {
      content: "Done.",
      model: "stub-1",
      tokens_used: 30,
    };
  }
}

async function main() {
  const db = new Database(":memory:");
  runMigrations(db, "agents", agentsMigrations);

  const events = new EventBus();
  const service = new AgentService(db, events);
  const executor = new AgentExecutor();

  const catalog = buildCatalog();
  executor.setKernelTools(catalog);

  // ── PART 1: inspect resolveTools output for both modes ──
  // resolveTools is private; bracket-access for the demo only.
  type ResolveToolsFn = (a: unknown) => {
    llmTools: { name: string }[];
    toolExecutor: Map<string, unknown>;
  };
  const resolveTools = (executor as unknown as { resolveTools: ResolveToolsFn })
    .resolveTools.bind(executor);

  const legacyAgent = service.createAgent({
    name: "legacy-agent",
    description: "all tools, no PD",
  });
  const pdAgent = service.createAgent({
    name: "pd-agent",
    description: "progressive discovery",
    progressive_discovery: true,
  });

  const legacyResolved = resolveTools(legacyAgent);
  const pdResolved = resolveTools(pdAgent);

  console.log("─".repeat(72));
  console.log("PART 1 — resolveTools static comparison");
  console.log("─".repeat(72));
  console.log(`Catalog size: ${catalog.length} tools (incl. ${metaSlot!.length} meta tools)`);
  console.log();
  console.log(
    `legacy agent  → llmTools: ${legacyResolved.llmTools.length} ` +
    `(every catalog entry sent every turn — meta tools included)`,
  );
  console.log(
    `pd agent      → llmTools: ${pdResolved.llmTools.length} ` +
    `(bootstrap: meta + social + workspace publish)`,
  );
  console.log();
  console.log("Bootstrap exposed to PD agent:");
  for (const t of pdResolved.llmTools) console.log(`  · ${t.name}`);
  console.log();

  // ── PART 2: end-to-end run with stub provider ──
  console.log("─".repeat(72));
  console.log("PART 2 — runToolLoop with PD: search → activate → direct call");
  console.log("─".repeat(72));

  const stub = new StubProvider();
  executor.setProviders(new Map([["stub", stub]]), "stub");

  const refreshed = service.getAgent(pdAgent.id)!;
  const run = service.createRun({
    agent_id: refreshed.id,
    trigger_type: "manual",
    goal: "Send an email about today's standup",
  });

  const result = await executor.execute({
    agent: refreshed,
    goal: "Send an email about today's standup",
    run,
    service,
  });

  console.log();
  console.log(`Run status: ${result.status}`);
  console.log(`Steps: ${result.steps_count}, tokens: ${result.tokens_used}`);
  console.log();
  console.log("Tools sent to LLM each turn:");
  for (let i = 0; i < stub.toolsPerTurn.length; i++) {
    const t = stub.toolsPerTurn[i];
    const newOnes = i === 0
      ? []
      : t.names.filter((n) => !stub.toolsPerTurn[i - 1].names.includes(n));
    const newSuffix = newOnes.length > 0 ? `  (+${newOnes.join(", ")})` : "";
    console.log(`  turn ${i + 1}: ${t.count} tools${newSuffix}`);
  }
  console.log();
  console.log(
    stub.toolsPerTurn[2]?.names.includes("kernel_comms_send")
      ? "✓ kernel_tool_activate added kernel_comms_send to the toolbox; turn 3 called it directly."
      : "✗ kernel_comms_send was NOT activated — something is wrong.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

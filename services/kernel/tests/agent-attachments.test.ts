/**
 * Agents with attachments: agents.run binds `attachment_ids` into the run's
 * payload; the executor builds the opening turn per entry of the model chain
 * (native for a vision model, text for a fallback without vision), retries
 * once as text when a block is refused, and hands the claude_code executor
 * the text form. Agent memory keeps the ids and returns their metas.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor, runAttachmentIds } from "../src/modules/agents/executor.js";
import { agentOperations } from "../src/modules/agents/operations.js";
import { registerAgentRoutes } from "../src/modules/agents/api-routes.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import { EventBus } from "../src/core/event-bus.js";
import * as providerHealth from "../src/core/llm/provider-health.js";
import type { Agent, AgentRun } from "../src/modules/agents/types.js";
import type { KernelConfig } from "../src/core/config.js";
import type { ToolDefinition } from "../src/core/types.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";
import type { ChatMessage, ContentBlock } from "../src/core/llm/chat-types.js";
import { attachmentsMigrations } from "../src/modules/attachments/migrations.js";
import { AttachmentService } from "../src/modules/attachments/service.js";
import { _setAttachmentServiceForTests } from "../src/modules/attachments/index.js";
import type { AttachmentMeta } from "../src/modules/attachments/types.js";

const work = mkdtempSync(join(tmpdir(), "kernl-agent-att-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let db: Database;
let attachments: AttachmentService;
let dataDir: string;

function addAttachment(kind: "image" | "document", filename: string, file: string, body: string, mime: string, derived: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const abs = join(dataDir, "attachments", id, file);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  db.prepare(
    `INSERT INTO attachments (id, kind, mime, filename, size_bytes, path, status, derived, error, bound_at, created_at)
     VALUES (?, ?, ?, ?, 10, ?, 'ready', ?, NULL, NULL, ?)`,
  ).run(id, kind, mime, filename, `attachments/${id}/${file}`, JSON.stringify(derived), new Date().toISOString());
  return id;
}
const addImage = () => addAttachment("image", "pantalla.png", "original.png", "PNG", "image/png", { width: 4, height: 3 });
const addPdf = () => addAttachment("document", "contrato.pdf", "original.pdf", "%PDF", "application/pdf", { pages: 3, text: "cláusula primera" });

beforeEach(() => {
  providerHealth._resetForTests();
  db = new Database(":memory:");
  runMigrations(db as unknown as never, "attachments", attachmentsMigrations);
  dataDir = mkdtempSync(join(work, "data-"));
  attachments = new AttachmentService(db as unknown as never, { dataDir, setting: () => undefined });
  _setAttachmentServiceForTests(attachments);
});
afterEach(() => {
  _setAttachmentServiceForTests(null);
  attachments.stop();
  providerHealth._resetForTests();
});

// ── Executor harness: canned service, scripted providers ──────────

const echoTool = {
  name: "kernel_test_echo",
  description: "Echo",
  inputSchema: z.object({ text: z.string() }),
  handler: async () => ({ content: [{ type: "text", text: "echo" }] }),
} as unknown as ToolDefinition;

function cannedService(chain: Array<{ provider: string; model: string }>, saved: string[]): AgentService {
  const canned: Record<string, (...args: unknown[]) => unknown> = {
    getEmbeddingsClient: () => null,
    resolveModelChain: () => chain,
    buildDirectoryBlock: () => "",
    buildHierarchyBlock: () => "",
    getUnreadInbox: () => [],
    getRelevantLearnings: () => [],
    getAgentStats: () => ({ total_runs: 0, success_rate: 0, avg_tokens: 0, avg_steps: 0, common_errors: [] }),
    findSimilarPastRuns: () => [],
    getRelevantMemory: () => [],
    getChainsBySource: () => [],
    getLearnings: () => [],
    saveCheckpoint: (_id: unknown, data: unknown) => { saved.push(String(data)); },
    recordRunOutcome: () => ({ paused: false, consecutive_failures: 0 }),
  };
  return new Proxy({}, {
    get: (_t, prop) => (typeof prop === "string" ? (...args: unknown[]) => canned[prop]?.(...args) : undefined),
  }) as unknown as AgentService;
}

type Call = { name: string; messages: ChatMessage[] };
function scripted(name: string, calls: Call[], steps: Array<() => unknown>): ChatLlmProvider {
  let i = 0;
  return {
    name,
    available: () => true,
    async chatCompletion(messages) {
      calls.push({ name, messages: JSON.parse(JSON.stringify(messages)) });
      return steps[Math.min(i++, steps.length - 1)]() as never;
    },
  };
}
const final = (text: string) => () => ({ content: text, tokens_used: 3, model: "stub" });
const toolCall = () => () => ({ content: "", tokens_used: 3, model: "stub", tool_calls: [{ type: "tool_use", id: "t1", name: "kernel_test_echo", input: { text: "x" } }] });
const boom = (msg: string) => () => { throw new Error(msg); };

const agent = (over: Partial<Agent> = {}) => ({
  id: "agent-1", name: "Nadia", description: "", system_prompt: "", goal_template: "",
  allowed_tools: JSON.stringify(["kernel_test_echo"]), denied_tools: "[]", provider: "", model: "",
  max_iterations: 5, timeout_ms: 60_000, active: 1, flow_id: "", max_tokens: 100_000, max_errors: 3,
  variables: "{}", show_on_dashboard: 0, builtin_handler: "", rank_id: "", model_chain: "",
  executor_type: "native", progressive_discovery: 0, language_override: "", skills_json: "", ...over,
}) as Agent;
const run = (ids: string[]) => ({
  id: "run-1", agent_id: "agent-1", trigger_type: "manual", status: "running", goal: "",
  trigger_payload: JSON.stringify({ attachment_ids: ids }),
}) as unknown as AgentRun;

function executor(providers: Record<string, ChatLlmProvider>): AgentExecutor {
  const ex = new AgentExecutor();
  ex.setConfig({ language: "en", agents: {} } as unknown as KernelConfig);
  ex.setKernelTools([echoTool]);
  ex.setProviders(new Map(Object.entries(providers)), Object.keys(providers)[0]);
  return ex;
}
const kinds = (m: ChatMessage) => (typeof m.content === "string" ? ["string"] : (m.content as ContentBlock[]).map((b) => b.type));

describe("executor", () => {
  it("rebuilds the opening turn per chain entry: native for vision, text for the fallback without it", async () => {
    const calls: Call[] = [];
    const saved: string[] = [];
    const ex = executor({
      claude: scripted("claude", calls, [boom("claude API error 503: overloaded")]),
      groq: scripted("groq", calls, [final("listo")]),
    });
    const img = addImage();
    const pdf = addPdf();
    const result = await ex.execute({
      agent: agent(), goal: "Revisá los adjuntos", run: run([img, pdf]),
      service: cannedService([{ provider: "claude", model: "claude-sonnet-5" }, { provider: "groq", model: "openai/gpt-oss-120b" }], saved),
    });

    expect(result.status).toBe("completed");
    expect(calls.map((c) => c.name)).toEqual(["claude", "groq"]);
    expect(kinds(calls[0].messages[0])).toEqual(["text", "image", "text", "document", "text"]);
    expect(kinds(calls[1].messages[0])).toEqual(["text", "text", "text", "text", "text"]);
    const groqText = JSON.stringify(calls[1].messages[0]);
    expect(groqText).toContain("[imagen: pantalla.png, 4×3]");
    expect(groqText).toContain("cláusula primera");
    expect((calls[1].messages[0].content as ContentBlock[]).at(-1)).toEqual({ type: "text", text: "Revisá los adjuntos" });
  });

  it("retries the same entry once with attachments as text when a block is refused", async () => {
    const calls: Call[] = [];
    const ex = executor({ claude: scripted("claude", calls, [boom("claude API error 400: image exceeds 5 MB maximum"), final("ok")]) });
    const result = await ex.execute({
      agent: agent(), goal: "mirá", run: run([addImage()]),
      service: cannedService([{ provider: "claude", model: "" }], []),
    });
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(kinds(calls[0].messages[0])).toContain("image");
    expect(kinds(calls[1].messages[0])).not.toContain("image");
  });

  it("checkpoints carry no attachment payload", async () => {
    const calls: Call[] = [];
    const saved: string[] = [];
    const ex = executor({ claude: scripted("claude", calls, [toolCall(), final("done")]) });
    await ex.execute({
      agent: agent(), goal: "usá la tool", run: run([addImage()]),
      service: cannedService([{ provider: "claude", model: "" }], saved),
    });
    expect(saved.length).toBeGreaterThan(0);
    for (const s of saved) {
      expect(s).not.toContain('"type":"image"');
      expect(s).toContain("[imagen adjunto omitido]");
    }
    // The live conversation still had the image on the second call.
    expect(kinds(calls[1].messages[0])).toContain("image");
  });

  it("the claude_code executor gets the attachments as text in its goal", async () => {
    const goals: string[] = [];
    const ex = executor({ claude: scripted("claude", [], [final("x")]) });
    ex.setClaudeCodeExecutor({
      execute: async (p: { goal: string }) => {
        goals.push(p.goal);
        return { status: "completed", result: "", error: "", steps_count: 1, tokens_used: 0 };
      },
      cancelRun: () => false,
    } as never);
    await ex.execute({
      agent: agent({ executor_type: "claude_code" }), goal: "Leé el contrato", run: run([addPdf()]),
      service: cannedService([], []),
    });
    expect(goals[0]).toStartWith("Leé el contrato\n\n[Adjunto: contrato.pdf · documento · 3 págs]");
    expect(goals[0]).toContain("cláusula primera");
  });

  it("runs without attachments keep a plain string goal", async () => {
    const calls: Call[] = [];
    const ex = executor({ claude: scripted("claude", calls, [final("x")]) });
    await ex.execute({ agent: agent(), goal: "hola", run: run([]), service: cannedService([{ provider: "claude", model: "" }], []) });
    expect(calls[0].messages[0]).toEqual({ role: "user", content: "hola" });
  });
});

// ── agents.run and agent memory, on a real AgentService ──────────

describe("agents.run and memory", () => {
  let service: AgentService;
  let server: KernelHttpServer;
  let base = "";

  beforeEach(async () => {
    runMigrations(db as unknown as never, "agents", agentsMigrations);
    const events = new EventBus();
    service = new AgentService(db as unknown as never, events);
    server = new KernelHttpServer({
      config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
    });
    registerAgentRoutes(server, service, new AgentExecutor(), events);
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    await server.stop();
  });

  const ops = () => agentOperations({
    service,
    executor: { execute: async () => ({ status: "completed", result: "", error: "", steps_count: 0, tokens_used: 0 }), cancelRun: () => false } as unknown as AgentExecutor,
  });

  it("binds attachment_ids into the run payload; the same ids serve another run", async () => {
    const a = service.createAgent({ name: "A" });
    const b = service.createAgent({ name: "B" });
    const img = addImage();
    const first = (await ops()["agents.run"]({ agent_id: a.id, goal: "g", attachment_ids: [img], chat: true })) as { run_id: string };
    const second = (await ops()["agents.run"]({ agent_id: b.id, goal: "g", attachment_ids: [img] })) as { run_id: string };
    expect(runAttachmentIds(service.getRun(first.run_id)!)).toEqual([img]);
    expect(JSON.parse(service.getRun(first.run_id)!.trigger_payload)).toMatchObject({ chat: true, attachment_ids: [img] });
    expect(runAttachmentIds(service.getRun(second.run_id)!)).toEqual([img]);
    expect(attachments.get(img)!.bound_at).not.toBeNull();
  });

  it("a bad id is a 400 and starts no run", async () => {
    const a = service.createAgent({ name: "A" });
    await expect((async () => ops()["agents.run"]({ agent_id: a.id, attachment_ids: [crypto.randomUUID()] }))()).rejects.toMatchObject({ status: 400 });
    expect(service.listRuns({ agent_id: a.id })).toHaveLength(0);
  });

  it("memory keeps the ids and returns their metas", async () => {
    const a = service.createAgent({ name: "A" });
    const pdf = addPdf();
    const post = await fetch(`${base}/api/agents/${a.id}/memory`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "te paso el contrato", attachment_ids: [pdf] }),
    });
    expect(post.status).toBe(200);
    const bad = await fetch(`${base}/api/agents/${a.id}/memory`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "x", attachment_ids: ["nope"] }),
    });
    expect(bad.status).toBe(400);

    const got = (await (await fetch(`${base}/api/agents/${a.id}/memory`)).json()) as {
      memory: Array<{ role: string; content: string; attachments: AttachmentMeta[] }>;
    };
    expect(got.memory).toHaveLength(1);
    expect(got.memory[0].content).toBe("te paso el contrato");
    expect(got.memory[0].attachments.map((m) => [m.id, m.filename])).toEqual([[pdf, "contrato.pdf"]]);
    expect(service.getMemory(a.id)[0].attachments).toEqual([pdf]);
  });
});

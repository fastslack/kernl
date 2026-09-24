/**
 * Characterization tests for AgentExecutor.execute().
 *
 * These pin the observable behaviour of the native (runToolLoop) path —
 * the exact system prompt sent to the LLM, the model-chain order, and the
 * full ordered trace of service writes, flow events and executor log lines —
 * so the method can be restructured without changing anything from the
 * outside. Every scenario records one flat trace and compares it to a
 * snapshot captured against the pre-refactor implementation.
 *
 * The service is a recording Proxy (every method call is logged with its
 * arguments and answered from a canned table), the providers are scripted
 * stubs, and the clock is frozen so dates/timestamps are stable.
 */

import { describe, it, expect, beforeEach, afterEach, setSystemTime, spyOn } from "bun:test";
import { z } from "zod";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import type { Agent, AgentRun } from "../src/modules/agents/types.js";
import type { AgentService } from "../src/modules/agents/service.js";
import type { EventBus } from "../src/core/event-bus.js";
import type { KernelConfig } from "../src/core/config.js";
import type { ToolDefinition } from "../src/core/types.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";
import * as providerHealth from "../src/core/llm/provider-health.js";
import { log } from "../src/core/logger.js";

type TraceEntry = [string, string, unknown];

function clone<T>(v: T): unknown {
  if (v === undefined) return null;
  return JSON.parse(JSON.stringify(v, (_k, val) => (val instanceof Error ? `Error(${val.message})` : val)));
}

function makeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "Nadia",
    description: "",
    system_prompt: "You are {{role}} for {{team}}. Unknown: {{missing}}.",
    goal_template: "",
    allowed_tools: "[]",
    denied_tools: "[]",
    provider: "",
    model: "",
    max_iterations: 20,
    timeout_ms: 60_000,
    active: 1,
    flow_id: "flow-9",
    max_tokens: 100_000,
    max_errors: 3,
    variables: JSON.stringify({ role: "an analyst", team: "Ops" }),
    show_on_dashboard: 0,
    builtin_handler: "",
    rank_id: "",
    model_chain: "",
    executor_type: "native",
    progressive_discovery: 0,
    language_override: "",
    skills_json: "",
    ...over,
  } as Agent;
}

function makeRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    agent_id: "agent-1",
    trigger_type: "manual",
    trigger_payload: "{}",
    goal: "",
    status: "running",
    ...over,
  } as unknown as AgentRun;
}

type Script = Array<(call: { system: string; tools: string[]; model?: string }) => unknown>;

interface Harness {
  trace: TraceEntry[];
  service: AgentService;
  events: EventBus;
  canned: Record<string, (...args: unknown[]) => unknown>;
  provider: (name: string, script: Script, opts?: { available?: boolean; supportsToolLoop?: boolean }) => ChatLlmProvider;
}

function makeHarness(): Harness {
  const trace: TraceEntry[] = [];
  const canned: Record<string, (...args: unknown[]) => unknown> = {
    getEmbeddingsClient: () => null,
    getAgent: () => undefined,
    resolveModelChain: () => [],
    buildDirectoryBlock: () => "",
    buildHierarchyBlock: () => "",
    getUnreadInbox: () => [],
    getRelevantLearnings: () => [],
    getRelevantLearningsByEmbedding: () => [],
    getAgentStats: () => ({ total_runs: 0, success_rate: 0, avg_tokens: 0, avg_steps: 0, common_errors: [] }),
    findSimilarPastRuns: () => [],
    findSimilarPastRunsByEmbedding: () => [],
    getRelevantMemory: () => [],
    getRelevantMemoryByEmbedding: () => [],
    getChainsBySource: () => [],
    getLearnings: () => [],
    getRun: () => undefined,
    createRun: () => ({ id: "child-run", agent_id: "agent-2", trigger_payload: "{}", trigger_type: "chain" }),
    findOrCreateChatConversation: () => ({ id: "convo-1" }),
    postMessage: () => ({ id: "msg-1" }),
    addFeedback: () => ({ id: "fb-1" }),
    addLearning: (input: unknown) => {
      const i = input as { type: string; content: string; confidence: number };
      return { id: "learning-1", type: i.type, content: i.content, confidence: i.confidence };
    },
    recordRunOutcome: () => ({ paused: false, consecutive_failures: 0 }),
  };
  const service = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      return (...args: unknown[]) => {
        trace.push(["svc", prop, clone(args)]);
        const f = canned[prop];
        return f ? f(...args) : undefined;
      };
    },
  }) as unknown as AgentService;
  const events = {
    emit(name: string, payload: unknown) {
      trace.push(["evt", name, clone(payload)]);
    },
  } as unknown as EventBus;

  const provider: Harness["provider"] = (name, script, opts = {}) => {
    let i = 0;
    return {
      name,
      available: () => opts.available ?? true,
      ...(opts.supportsToolLoop === undefined ? {} : { supportsToolLoop: opts.supportsToolLoop }),
      async chatCompletion(messages: unknown, o?: { system?: string; tools?: Array<{ name: string }>; model?: string; onRateLimitWait?: (ms: number, attempt: number) => void }) {
        const call = { system: o?.system ?? "", tools: (o?.tools ?? []).map((t) => t.name), model: o?.model };
        trace.push(["llm", name, clone({ ...call, messages })]);
        const step = script[Math.min(i++, script.length - 1)];
        const out = step(call);
        if (out === "RATE_LIMIT") {
          o?.onRateLimitWait?.(4200, 2);
          return { content: "after wait", tokens_used: 7, model: "stub" };
        }
        return out;
      },
    } as unknown as ChatLlmProvider;
  };

  return { trace, service, events, canned, provider };
}

const echoTool: ToolDefinition = {
  name: "kernel_test_echo",
  description: "Echo the input back",
  inputSchema: z.object({ text: z.string() }),
  handler: async (args: unknown) => ({
    content: [{ type: "text", text: `echo:${(args as { text: string }).text}` }],
  }),
} as unknown as ToolDefinition;

const workspaceTool: ToolDefinition = {
  name: "kernel_workspace_search",
  description: "Search the workspace",
  inputSchema: z.object({ q: z.string() }),
  handler: async () => ({ content: [{ type: "text", text: "nothing" }] }),
} as unknown as ToolDefinition;

const toolUse = (name: string, input: Record<string, unknown>, id = "tu-1") => ({
  content: "thinking out loud",
  tokens_used: 11,
  model: "stub",
  tool_calls: [{ type: "tool_use", id, name, input }],
});
const final = (text: string, tokens = 13) => ({ content: text, tokens_used: tokens, model: "stub" });

let logSpies: Array<ReturnType<typeof spyOn>> = [];

function captureLogs(trace: TraceEntry[]): void {
  // Only executor-owned lines — tool-loop/provider internals are not pinned here.
  const own = /^(Agent|AgentExecutor|Builtin handler|Declarative chain)/;
  for (const level of ["debug", "info", "warn", "error"] as const) {
    logSpies.push(
      spyOn(log, level).mockImplementation(((msg: string, data?: unknown) => {
        if (own.test(msg)) trace.push(["log", level, data === undefined ? msg : [msg, clone(data)]]);
      }) as never),
    );
  }
}

function makeExecutor(h: Harness, config: Partial<KernelConfig> & { agents?: Record<string, unknown> }): AgentExecutor {
  const ex = new AgentExecutor();
  ex.setConfig(config as KernelConfig);
  ex.setKernelTools([echoTool, workspaceTool]);
  return ex;
}

beforeEach(() => {
  setSystemTime(new Date("2026-03-04T05:06:07.000Z"));
  providerHealth._resetForTests();
});

afterEach(() => {
  setSystemTime();
  for (const s of logSpies) s.mockRestore();
  logSpies = [];
  providerHealth._resetForTests();
});

describe("AgentExecutor.execute — characterization", () => {
  it("assembles every system-prompt block in order and persists the whole tool loop (semantic ranking)", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, {
      language: "en",
      agents: {
        useSemanticRanking: true,
        semanticRankingCosineWeight: 0.7,
        semanticRankingMinScore: 0.2,
        maxInvokeDepth: 4,
        defaultModelChain: [{ provider: "alpha", model: "alpha-1" }],
      },
    } as never);
    ex.setSkillResolver({
      buildPromptIndex: (slugs: string[]) => `## Skills\n${slugs.map((s) => `- ${s}`).join("\n")}`,
    } as never);
    ex.setEvalService({
      isEnabled: () => true,
      evaluate: async () => ({ score: 4, outcome: "success", lesson: "keep it short", confidence: 0.9, issues: "none", tokens_used: 5 }),
    } as never);

    h.canned.getEmbeddingsClient = () => ({ embed: async () => [[0.1, 0.2, 0.3]] });
    h.canned.buildDirectoryBlock = () => "## Directory\n- Bob (agent-2)";
    h.canned.buildHierarchyBlock = () => "## Hierarchy\nRank: Lead";
    h.canned.getUnreadInbox = () => [
      { id: "in-1", from_agent_id: "agent-2", created_at: "2026-03-01T10:11:12.000Z", subject: "Help", body: "Please check X" },
      { id: "in-2", from_agent_id: "ghost", created_at: "2026-03-02T01:02:03.000Z", subject: "Ping", body: "Are you there?" },
    ];
    h.canned.getAgent = (id: unknown) => (id === "agent-2" ? makeAgent({ id: "agent-2", name: "Bob" }) : undefined);
    h.canned.getRelevantLearningsByEmbedding = () => [
      { type: "avoid", confidence: 0.8, content: "Do not guess" },
      { type: "prefer", confidence: 0.55, content: "Cite sources" },
    ];
    h.canned.getAgentStats = () => ({ total_runs: 12, success_rate: 75, avg_tokens: 900, avg_steps: 4, common_errors: ["timeout", "429"] });
    h.canned.findSimilarPastRunsByEmbedding = () => [
      { status: "completed", goal: "Summarize   the\nweek", result: "Done  well", error: "" },
      { status: "failed", goal: "Other", result: "", error: "boom" },
    ];
    h.canned.getRelevantMemoryByEmbedding = () => [
      { role: "user", created_at: "2026-03-03T09:00:00.000Z", content: "newest question" },
      { role: "assistant", created_at: "2026-03-02T08:00:00.000Z", content: "older answer" },
    ];

    const alpha = h.provider("alpha", [
      () => "RATE_LIMIT",
      () => toolUse("kernel_test_echo", { text: "hi" }),
      () => final("All done"),
    ]);
    ex.setProviders(new Map([["alpha", alpha]]), "alpha");
    captureLogs(h.trace);

    const result = await ex.execute({
      agent: makeAgent({
        progressive_discovery: 1,
        skills_json: JSON.stringify(["pdf", "xlsx"]),
      }),
      goal: "Review {{team}} backlog",
      run: makeRun(),
      service: h.service,
      events: h.events,
      depth: 1,
    });

    // The exact prompt text, pinned explicitly in addition to the snapshot.
    const firstCall = h.trace.find((t) => t[0] === "llm") as TraceEntry;
    const system = (firstCall[2] as { system: string }).system;
    expect(system.startsWith("You are an analyst for Ops. Unknown: {{missing}}.\n\n")).toBe(true);
    const order = [
      "You are an analyst",
      "## Skills",
      "## Directory",
      "## Hierarchy",
      "PENDING REQUESTS FROM COLLEAGUES",
      "## Learnings from past runs",
      "## Performance (12 past runs)",
      "## Similar past runs",
    ].map((s) => system.indexOf(s));
    expect(order.every((v) => v >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("builds the minimal prompt with lexical ranking and a Spanish override", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, { language: "en", agents: {} } as never);
    const beta = h.provider("beta", [() => final("Listo")]);
    ex.setProviders(new Map([["beta", beta]]), "beta");
    captureLogs(h.trace);

    const result = await ex.execute({
      agent: makeAgent({
        system_prompt: "",
        language_override: "es",
        allowed_tools: JSON.stringify(["kernel_test_echo"]),
        variables: "not json",
      }),
      goal: "Hacé {{algo}}",
      run: makeRun({ trigger_type: "schedule" }),
      service: h.service,
      events: h.events,
    });

    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("orders the model chain: dedupe, drop empties/unavailable/tool-incapable, blocked providers last", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, {
      language: "en",
      agents: {
        defaultModelChain: [
          { provider: "a", model: "a1" },
          { provider: "cc", model: "" },
          { provider: "c", model: "c1" },
          { provider: "d", model: "d1" },
        ],
      },
    } as never);
    h.canned.resolveModelChain = () => [
      { provider: "a", model: "a1" },
      { provider: "", model: "" },
      { provider: "b", model: "b1" },
      { provider: "missing", model: "x" },
    ];
    const boom = () => { throw new Error("API error 503: upstream"); };
    ex.setProviders(new Map([
      ["a", h.provider("a", [boom])],
      ["b", h.provider("b", [boom])],
      ["c", h.provider("c", [boom])],
      ["cc", h.provider("cc", [boom], { supportsToolLoop: false })],
      ["d", h.provider("d", [boom], { available: false })],
    ]), "a");
    providerHealth.recordFailure("b", "auth");
    captureLogs(h.trace);

    const result = await ex.execute({
      agent: makeAgent(), goal: "go", run: makeRun(), service: h.service, events: h.events,
    });

    const called = h.trace.filter((t) => t[0] === "llm").map((t) => t[1]);
    expect(called).toEqual(["a", "c", "b"]);
    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("falls back to any alive tool-capable provider when the whole chain is unavailable", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, { language: "en", agents: { defaultModelChain: [{ provider: "gone", model: "g1" }] } } as never);
    ex.setProviders(new Map([
      ["gone", h.provider("gone", [() => final("x")], { available: false })],
      ["cc", h.provider("cc", [() => final("x")], { supportsToolLoop: false })],
      ["alive", h.provider("alive", [() => final("fallback ok")])],
    ]), "gone");
    captureLogs(h.trace);
    const result = await ex.execute({ agent: makeAgent(), goal: "go", run: makeRun(), service: h.service, events: h.events });
    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("fails precisely when only tool-incapable providers remain", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, { language: "en", agents: { defaultModelChain: [{ provider: "cc", model: "" }] } } as never);
    ex.setProviders(new Map([["cc", h.provider("cc", [() => final("x")], { supportsToolLoop: false })]]), "cc");
    captureLogs(h.trace);
    const result = await ex.execute({ agent: makeAgent(), goal: "go", run: makeRun(), service: h.service, events: h.events });
    // Failed before the loop started, and still unregistered (it used to
    // stay in the active-runs registry forever).
    expect(ex.getActiveRunIds()).toEqual([]);
    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("fails with the chain listing when no provider is available", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, { language: "en", agents: {} } as never);
    ex.setProviders(new Map([["off", h.provider("off", [() => final("x")], { available: false })]]), "off");
    captureLogs(h.trace);
    const result = await ex.execute({ agent: makeAgent(), goal: "go", run: makeRun(), service: h.service, events: h.events });
    // Failed before the loop started, and still unregistered (it used to
    // stay in the active-runs registry forever).
    expect(ex.getActiveRunIds()).toEqual([]);
    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("records a safety abort as an error step and fails the run", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, { language: "en", agents: {} } as never);
    ex.setProviders(new Map([["p", h.provider("p", [
      () => ({ ...toolUse("kernel_test_echo", { text: "a" }), tokens_used: 500 }),
      () => final("never"),
    ])]]), "p");
    captureLogs(h.trace);
    const result = await ex.execute({
      agent: makeAgent({ max_tokens: 100 }), goal: "go", run: makeRun(), service: h.service, events: h.events,
    });
    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("cycles through other providers on a quota error (lmstudio gets the trimmed request)", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, { language: "en", agents: { defaultModelChain: [{ provider: "quota1", model: "q" }] } } as never);
    ex.setProviders(new Map([
      ["quota1", h.provider("quota1", [() => { throw new Error("API error 429 insufficient_quota"); }])],
      ["quota2", h.provider("quota2", [() => { throw new Error("API error 429 again"); }])],
      ["lmstudio", h.provider("lmstudio", [() => final("local answer")])],
    ]), "quota1");
    captureLogs(h.trace);
    const result = await ex.execute({
      agent: makeAgent({ system_prompt: "S".repeat(4000) }),
      goal: "G".repeat(2500),
      run: makeRun(),
      service: h.service,
      events: h.events,
    });
    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("records a non-retryable error, saves it to memory and auto-evaluates the failure", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, { language: "en", agents: {} } as never);
    ex.setEvalService({
      isEnabled: () => true,
      evaluate: async () => ({ score: 1, outcome: "failure", lesson: "check input", confidence: 0.7, issues: "bad", tokens_used: 3 }),
    } as never);
    ex.setProviders(new Map([["p", h.provider("p", [() => { throw new Error("invalid request body"); }])]]), "p");
    captureLogs(h.trace);
    const result = await ex.execute({ agent: makeAgent(), goal: "go", run: makeRun(), service: h.service, events: h.events });
    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("wires kernel_agents_invoke per run and runs the invoked agent", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, { language: "en", agents: {} } as never);
    ex.setBuiltinHandlers(new Map([["stub:answer", async () => "child says hi"]]));
    h.canned.getAgent = (id: unknown) =>
      id === "agent-2" ? makeAgent({ id: "agent-2", name: "Bob", builtin_handler: "stub:answer" }) : undefined;
    ex.setProviders(new Map([["p", h.provider("p", [
      () => toolUse("kernel_agents_invoke", { agent_id: "agent-2", goal: "say hi" }),
      () => final("parent done"),
    ])]]), "p");
    captureLogs(h.trace);
    const result = await ex.execute({
      agent: makeAgent(), goal: "go", run: makeRun({ trigger_payload: JSON.stringify({ root_run_id: "root-0" }) }),
      service: h.service, events: h.events,
    });
    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("fails without calling the LLM when no tool resolves", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, { language: "en", agents: {} } as never);
    ex.setProviders(new Map([["p", h.provider("p", [() => final("x")])]]), "p");
    captureLogs(h.trace);
    const result = await ex.execute({
      agent: makeAgent({ allowed_tools: JSON.stringify(["nope"]), denied_tools: JSON.stringify(["kernel_agents_invoke"]) }),
      goal: "go", run: makeRun(), service: h.service, events: h.events,
    });
    // Failed before the loop started, and still unregistered (it used to
    // stay in the active-runs registry forever).
    expect(ex.getActiveRunIds()).toEqual([]);
    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("short-circuits: depth guard, builtin handler (ok and failing), claude_code unwired and wired", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, { language: "en", agents: { maxInvokeDepth: 2 } } as never);
    ex.setBuiltinHandlers(new Map<string, () => Promise<unknown>>([
      ["ok", async () => "fine"],
      ["bad", async () => { throw new Error("handler exploded"); }],
    ]) as never);
    captureLogs(h.trace);
    const out: unknown[] = [];
    out.push(await ex.execute({ agent: makeAgent(), goal: "g", run: makeRun(), service: h.service, events: h.events, depth: 3 }));
    out.push(await ex.execute({ agent: makeAgent({ builtin_handler: "ok" }), goal: "g", run: makeRun(), service: h.service, events: h.events }));
    out.push(await ex.execute({ agent: makeAgent({ builtin_handler: "bad" }), goal: "g", run: makeRun(), service: h.service, events: h.events }));
    out.push(await ex.execute({ agent: makeAgent({ executor_type: "claude_code" }), goal: "g", run: makeRun(), service: h.service, events: h.events }));
    ex.setClaudeCodeExecutor({
      execute: async () => ({ status: "completed", result: "sdk", error: "", steps_count: 2, tokens_used: 9 }),
      cancelRun: () => false,
    } as never);
    out.push(await ex.execute({ agent: makeAgent({ executor_type: "claude_code" }), goal: "g", run: makeRun(), service: h.service, events: h.events }));
    expect(ex.getActiveRunIds()).toEqual([]);
    expect(out).toMatchSnapshot("results");
    expect(h.trace).toMatchSnapshot("trace");
  });

  it("stops on cancellation and unregisters the run", async () => {
    const h = makeHarness();
    const ex = makeExecutor(h, { language: "en", agents: {} } as never);
    ex.setProviders(new Map([["p", h.provider("p", [
      () => {
        expect(ex.getActiveRunIds()).toEqual(["run-1"]);
        ex.cancelRun("run-1");
        return toolUse("kernel_test_echo", { text: "x" });
      },
    ])]]), "p");
    captureLogs(h.trace);
    const result = await ex.execute({ agent: makeAgent(), goal: "go", run: makeRun(), service: h.service, events: h.events });
    expect(ex.getActiveRunIds()).toEqual([]);
    expect(result).toMatchSnapshot("result");
    expect(h.trace).toMatchSnapshot("trace");
  });
});

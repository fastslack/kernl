import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

// What the CLI sends when the subscription is over its limit: the notice as an
// assistant text with `error: "rate_limit"`, then a *success* result flagged
// is_error / 429. Read for its text alone, that is an answer.
const RESETS_S = Math.floor(Date.UTC(2026, 9, 18, 14) / 1000);
const limitedTurn = (model: string) => [
  { type: "system", subtype: "init", session_id: `s-${model}` },
  {
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: RESETS_S, rateLimitType: "seven_day" },
  },
  {
    type: "assistant",
    error: "rate_limit",
    message: { content: [{ type: "text", text: "You've hit your limit · resets Oct 18" }] },
  },
  {
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 429,
    result: "You've hit your limit · resets Oct 18",
  },
];
const answeredTurn = (text: string) => [
  { type: "system", subtype: "init", session_id: "s-ok" },
  { type: "assistant", message: { content: [{ type: "text", text }] } },
  { type: "result", subtype: "success", is_error: false, result: text },
];

const limitedModels = new Set<string>();
const partialModels = new Set<string>();
const calls: string[] = [];
// The mock is process-wide under `bun test`; other files get the real query.
let active = true;
const real = await import("@anthropic-ai/claude-agent-sdk");
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...real,
  query: (args: Parameters<typeof real.query>[0]) => {
    if (!active) return real.query(args);
    const options = args.options as { model: string };
    calls.push(options.model);
    const msgs = partialModels.has(options.model)
      ? [...answeredTurn("work already done").slice(0, 2), ...limitedTurn(options.model)]
      : limitedModels.has(options.model) ? limitedTurn(options.model) : answeredTurn(`hola desde ${options.model}`);
    return {
      async *[Symbol.asyncIterator]() { for (const m of msgs) yield m; },
      close() {},
    };
  },
}));

const limits = await import("../src/sdk/claude-limits.js");
const { ChatClaudeCodeProvider } = await import("../src/core/llm/claude-code-adapter.js");
const { classifyError } = await import("../src/core/llm/provider-health.js");
const { classifyProviderError } = await import("../src/core/llm/provider-errors.js");

const { ClaudeCodeExecutor } = await import("../assets/extensions/agents/agent-advanced/_module/claude-code-executor.js");
const { runMigrations } = await import("../src/core/db/migrations.js");
const { agentsMigrations } = await import("../src/modules/agents/migrations.js");
const { AgentService } = await import("../src/modules/agents/service.js");
const { EventBus } = await import("../src/core/event-bus.js");

afterAll(() => { active = false; });

const provider = () => new ChatClaudeCodeProvider("claude-opus-5-5", { cliPath: "/bin/sh" });
const ask = (p: InstanceType<typeof ChatClaudeCodeProvider>) =>
  p.chatCompletion([{ role: "user", content: "hola" }], { model: "claude-opus-5-5" });

beforeEach(() => {
  limits.clearClaudeLimits();
  limitedModels.clear();
  partialModels.clear();
  calls.length = 0;
  delete process.env.CLAUDE_CODE_LIMIT_FALLBACK_MODEL;
});

describe("ClaudeLimitObserver", () => {
  it("flags the notice and keeps the reset time and limit type", () => {
    const o = new limits.ClaudeLimitObserver();
    const flagged = limitedTurn("opus").map((m) => o.observe(m));
    expect(flagged).toEqual([false, false, true, true]);
    expect(o.hit).toEqual({
      kind: "rate_limit",
      resetsAt: RESETS_S * 1000,
      limitType: "seven_day",
      detail: "You've hit your limit · resets Oct 18",
    });
  });

  it("leaves an ordinary answer alone", () => {
    const o = new limits.ClaudeLimitObserver();
    expect(answeredTurn("ok").map((m) => o.observe(m))).toEqual([false, false, false]);
    expect(o.hit).toBeNull();
  });

  it("does not confuse an explanation of a limit with a CLI notice", () => {
    const observer = new limits.ClaudeLimitObserver();
    for (const msg of answeredTurn("The provider said: You've hit your weekly limit · resets 2pm (UTC)")) expect(observer.observe(msg)).toBe(false);
    expect(observer.hit).toBeNull();
  });

  it("reads a billing error as billing", () => {
    const o = new limits.ClaudeLimitObserver();
    o.observe({ type: "assistant", error: "billing_error", message: { content: [{ type: "text", text: "Credit balance is too low" }] } });
    expect(o.hit?.kind).toBe("billing");
  });
});

describe("text-only weekly limit", () => {
  it("detects the CLI notice without an HTTP status", () => {
    const observer = new limits.ClaudeLimitObserver();
    expect(observer.observe({ type: "assistant", message: { content: [{ type: "text", text: "You've hit your weekly limit · resets 2pm (UTC)" }] } })).toBe(true);
    expect(observer.observe({ type: "result", is_error: true, result: "You've hit your weekly limit · resets 2pm (UTC)" })).toBe(true);
    expect(observer.hit?.kind).toBe("rate_limit");
  });
});

describe("the limit error", () => {
  it("is what the provider chain falls back from", () => {
    const err = new limits.ClaudeUsageLimitError({ kind: "rate_limit", detail: "You've hit your limit" }, "claude-opus-5-5");
    expect(classifyError(err)).toBe("exhausted");
    expect(classifyProviderError(err).code).toBe("quota");
  });
});

describe("ChatClaudeCodeProvider on a usage limit", () => {
  it("answers on Fable instead of returning the notice", async () => {
    limitedModels.add("claude-opus-5-5");
    const res = await ask(provider());
    expect(res.content).toBe("hola desde claude-fable-5-1");
    expect(calls).toEqual(["claude-opus-5-5", "claude-fable-5-1"]);
  });

  it("goes straight to Fable while the limit lasts", async () => {
    limitedModels.add("claude-opus-5-5");
    await ask(provider());
    calls.length = 0;
    await ask(provider());
    expect(calls).toEqual(["claude-fable-5-1"]);
  });

  it("throws a 429 when Fable is limited too", async () => {
    limitedModels.add("claude-opus-5-5");
    limitedModels.add("claude-fable-5-1");
    await expect(ask(provider())).rejects.toThrow(/429 usage limit reached on claude-fable-5-1/);
    expect(limits.isClaudeModelLimited("claude-fable-5-1")).toBe(true);
  });

  it("does not retry when the fallback is turned off", async () => {
    process.env.CLAUDE_CODE_LIMIT_FALLBACK_MODEL = "";
    limitedModels.add("claude-opus-5-5");
    await expect(ask(provider())).rejects.toBeInstanceOf(limits.ClaudeUsageLimitError);
    expect(calls).toEqual(["claude-opus-5-5"]);
  });

  it("streams the Fable answer and never the notice", async () => {
    limitedModels.add("claude-opus-5-5");
    const texts: string[] = [];
    const run = await provider().chatCompletionStream("hola", (ev) => {
      if (ev.type === "assistant_text") texts.push(ev.text);
    }, { model: "claude-opus-5-5" });
    expect(texts).toEqual(["hola desde claude-fable-5-1"]);
    expect(run.finalText).toBe("hola desde claude-fable-5-1");
  });
});

describe("claude_code agent run on a usage limit", () => {
  const prevPath = process.env.CLAUDE_CODE_PATH;
  afterAll(() => {
    if (prevPath === undefined) delete process.env.CLAUDE_CODE_PATH;
    else process.env.CLAUDE_CODE_PATH = prevPath;
  });

  function setup(opts: { chain?: Array<{ provider: string; model: string }>; tools?: string[] } = {}) {
    process.env.CLAUDE_CODE_PATH = "/bin/sh";
    const db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    const service = new AgentService(db as never, new EventBus());
    const agent = service.createAgent({ name: "Coder", executor_type: "claude_code", model: "claude-opus-5-5", allowed_tools: opts.tools ?? [] } as never);
    service.setExecutorType(agent.id, "claude_code");
    if (opts.chain) service.setModelChain(agent.id, opts.chain as never);
    const run = service.createRun({ agent_id: agent.id, goal: "x" });
    service.updateRun(run.id, { status: "running" });
    return { service, agent: service.getAgent(agent.id)!, run };
  }

  it("finishes on Fable and records the switch", async () => {
    limitedModels.add("claude-opus-5-5");
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("completed");
    expect(result.result).toBe("hola desde claude-fable-5-1");
    expect(calls).toEqual(["claude-opus-5-5", "claude-fable-5-1"]);
  }, 30_000);

  it("continues on the model the agent's own chain names when the subscription is exhausted", async () => {
    limitedModels.add("claude-opus-5-5");
    limitedModels.add("claude-fable-5-1");
    const { service, agent, run } = setup({ chain: [{ provider: "claude_code", model: "claude-opus-5-5" }, { provider: "backup", model: "" }] });
    const { AgentExecutor } = await import("../src/modules/agents/executor.js");
    const executor = new AgentExecutor();
    const cli = new ClaudeCodeExecutor();
    const { z } = await import("zod");
    let invoked = false;
    let cleaned = false;
    cli.prepareNativeFallbackTools = async () => ({
      tools: [{name:"Bash",description:"Run sandbox shell",inputSchema:z.object({command:z.string()}),handler:async()=>{invoked=true;return {content:[{type:"text",text:"actual coding output"}]};}}],
      cleanup:async()=>{cleaned=true;}, prompt:"Native coding workspace: /workspace",
    });
    executor.setClaudeCodeExecutor(cli);
    executor.setConfig({ language: "en", agents: { defaultModelChain: [{ provider: "backup", model: "" }] } } as never);
    executor.setProviders(new Map([["backup", {
      name: "backup", available: () => true, getDefaultModel: () => "backup-model",
      async chatCompletion(_messages: unknown, options: { model?: string; tools?: Array<{name:string}>; system?:string }) {
        expect(options.tools?.some(t=>t.name==="Bash")).toBe(true);
        expect(options.system).toContain("/workspace");
        if(!invoked) return {content:"",tokens_used:1,model:"backup-model",tool_calls:[{type:"tool_use",id:"coding",name:"Bash",input:{command:"pwd"}}]};
        expect(options.model).toBe("backup-model");
        return { content: "completed with backup", tokens_used: 7, model: "backup-model" };
      },
    } as never]]), "backup");
    const events = new EventBus();
    const switches: unknown[] = [];
    events.on("agent:flow:fallback_used", (payload) => { switches.push(payload); });
    const result = await executor.execute({ agent, goal: "x", run, service, events });
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ from_provider: "claude_code", from_model: "claude-opus-5-5", to_provider: "backup", to_model: "backup-model", run_id: run.id });
    expect(result.status).toBe("completed");
    expect(invoked).toBe(true);
    expect(cleaned).toBe(true);
    expect(result.result).toBe("completed with backup");
    expect(service.getAgent(agent.id)?.executor_type).toBe("claude_code");
  }, 30_000);

  it("keeps a coding agent waiting for the reset instead of handing it to the global chain", async () => {
    limitedModels.add("claude-opus-5-5");
    limitedModels.add("claude-fable-5-1");
    const { service, agent, run } = setup();
    const { AgentExecutor } = await import("../src/modules/agents/executor.js");
    const { CLAUDE_LIMIT_WAITING } = await import("../src/sdk/claude-access.js");
    const executor = new AgentExecutor();
    executor.setClaudeCodeExecutor(new ClaudeCodeExecutor());
    executor.setConfig({ language: "en", agents: { defaultModelChain: [{ provider: "backup", model: "" }] } } as never);
    let called = false;
    executor.setProviders(new Map([["backup", { name: "backup", available: () => true, getDefaultModel: () => "b",
      async chatCompletion() { called = true; return { content: "x", tokens_used: 1, model: "b" }; } } as never]]), "backup");
    const result = await executor.execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("failed");
    expect(result.error).toContain(CLAUDE_LIMIT_WAITING);
    expect(called).toBe(false);
    service.recordRunOutcome(agent.id, { ok: false, error: result.error });
    expect(service.getAgent(agent.id)?.consecutive_failures ?? 0).toBe(0);
  }, 30_000);

  it("still sends an agent that only uses kernel tools down the global chain", async () => {
    limitedModels.add("claude-opus-5-5");
    limitedModels.add("claude-fable-5-1");
    const { service, agent, run } = setup({ tools: ["kernel_notes_create"] });
    const { AgentExecutor } = await import("../src/modules/agents/executor.js");
    const executor = new AgentExecutor();
    executor.setClaudeCodeExecutor(new ClaudeCodeExecutor());
    executor.setConfig({ language: "en", agents: { defaultModelChain: [{ provider: "backup", model: "" }] } } as never);
    executor.setProviders(new Map([["backup", { name: "backup", available: () => true, getDefaultModel: () => "b",
      async chatCompletion() { return { content: "done on backup", tokens_used: 1, model: "b" }; } } as never]]), "backup");
    const result = await executor.execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("completed");
    expect(result.result).toBe("done on backup");
  }, 30_000);

  it("does not restart work already performed before the limit", async () => {
    partialModels.add("claude-opus-5-5");
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, allowProviderFallback: true });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("429 usage limit");
    expect(calls).toEqual(["claude-opus-5-5"]);
  }, 30_000);

  it("fails with the limit instead of completing with the notice", async () => {
    limitedModels.add("claude-opus-5-5");
    limitedModels.add("claude-fable-5-1");
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/429 usage limit reached on claude-fable-5-1 \(seven_day, resets 2026-10-18T14:00:00.000Z\)/);
    expect(result.result).not.toMatch(/hit your limit/);
  }, 30_000);
});


describe("Claude limit diagnostics", () => {
  it("reports the subscription notice for the short model alias too", () => {
    limits.rememberClaudeLimit("claude-sonnet-5-5", { kind: "rate_limit", detail: "weekly quota exhausted", resetsAt: RESETS_S * 1000 });
    expect(limits.getClaudeModelLimit("sonnet")).toMatchObject({ detail: "weekly quota exhausted", resetsAt: RESETS_S * 1000 });
    expect(limits.getClaudeModelLimit("haiku")).toBeNull();
  });
});

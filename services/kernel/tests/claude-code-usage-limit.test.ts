import { describe, it, expect, mock, beforeEach, afterEach, afterAll, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What the CLI sends when the subscription is over its limit: the notice as an
// assistant text with `error: "rate_limit"`, then a *success* result flagged
// is_error / 429. Read for its text alone, that is an answer.
const RESETS_S = Math.floor(Date.UTC(2026, 9, 18, 14) / 1000);
// A test that needs the limit to lift during the run sets this (epoch ms).
let resetsAtOverride: number | undefined;
const limitedTurn = (model: string) => [
  { type: "system", subtype: "init", session_id: `s-${model}` },
  {
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: resetsAtOverride ?? RESETS_S, rateLimitType: "seven_day" },
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
// Per account: keyed by `${CLAUDE_CONFIG_DIR}|${model}`.
const limitedRoutes = new Set<string>();
const partialRoutes = new Set<string>();
const calls: string[] = [];
const routes: Array<{ dir: string | undefined; model: string; token: string | undefined }> = [];
// Account dirs whose CLI session is dead: the SDK throws, or (resultDeadDirs)
// the CLI says so in its result.
const deadDirs = new Set<string>();
const resultDeadDirs = new Set<string>();
const DEAD_SESSION = "OAuth token has expired and could not be refreshed";
// Called once a query has streamed all its messages, e.g. to cancel the run.
let onQueryEnd: (() => void) | null = null;
// The mock is process-wide under `bun test`; other files get the real query.
let active = true;
const real = await import("@anthropic-ai/claude-agent-sdk");
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...real,
  query: (args: Parameters<typeof real.query>[0]) => {
    if (!active) return real.query(args);
    const options = args.options as { model: string; env?: Record<string, string | undefined> };
    calls.push(options.model);
    const dir = options.env?.CLAUDE_CONFIG_DIR;
    routes.push({ dir, model: options.model, token: options.env?.CLAUDE_CODE_OAUTH_TOKEN });
    const key = `${dir}|${options.model}`;
    if (dir && deadDirs.has(dir)) {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "s-dead" };
          throw new Error(`Claude Code returned an error result: ${DEAD_SESSION}`);
        },
        close() {},
      };
    }
    if (dir && resultDeadDirs.has(dir)) {
      const dead = [
        { type: "system", subtype: "init", session_id: "s-dead" },
        { type: "assistant", message: { content: [{ type: "text", text: DEAD_SESSION }] } },
        { type: "result", subtype: "error_during_execution", is_error: true, errors: [DEAD_SESSION] },
      ];
      return { async *[Symbol.asyncIterator]() { for (const m of dead) yield m; }, close() {} };
    }
    const msgs = partialModels.has(options.model) || partialRoutes.has(key)
      ? [...answeredTurn("work already done").slice(0, 2), ...limitedTurn(options.model)]
      : limitedModels.has(options.model) || limitedRoutes.has(key) ? limitedTurn(options.model) : answeredTurn(`hola desde ${options.model}`);
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of msgs) yield m;
        onQueryEnd?.();
      },
      close() {},
    };
  },
}));

const limits = await import("../src/sdk/claude-limits.js");
const { listInFlight, clearInFlight } = await import("../src/sdk/llm-inflight.js");
const { setClaudeAccountResolver, setClaudePrimaryTokenProbe, claudeAccountDir } = await import("../src/sdk/claude-accounts.js");
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
  limitedRoutes.clear();
  partialRoutes.clear();
  deadDirs.clear();
  resultDeadDirs.clear();
  onQueryEnd = null;
  resetsAtOverride = undefined;
  calls.length = 0;
  routes.length = 0;
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


describe("claude_code agent run across several accounts", () => {
  const OPUS = "claude-opus-5-5";
  const FABLE = "claude-fable-5-1";
  const prevPath = process.env.CLAUDE_CODE_PATH;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const prevSqlite = process.env.SQLITE_PATH;
  let xdg = "";
  let A = "";
  let B = "";

  beforeEach(() => {
    process.env.CLAUDE_CODE_PATH = "/bin/sh";
    xdg = mkdtempSync(join(tmpdir(), "claude-exec-accounts-"));
    process.env.XDG_CONFIG_HOME = xdg;
    // Sandboxed runs keep their transcripts under the data dir; not the real one.
    process.env.SQLITE_PATH = join(xdg, "data", "kernel.db");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    setClaudePrimaryTokenProbe(() => false);
    setClaudeAccountResolver(() => [{ id: "A", label: "Work" }, { id: "B", label: "" }]);
    A = claudeAccountDir("A");
    B = claudeAccountDir("B");
    for (const dir of [A, B]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".credentials.json"), "{}");
    }
    // B has no label: events name it by the subscription's email.
    writeFileSync(join(B, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "b@example.com" } }));
  });

  afterEach(() => {
    setClaudeAccountResolver(null);
    setClaudePrimaryTokenProbe(null);
    rmSync(xdg, { recursive: true, force: true });
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
    if (prevSqlite === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlite;
  });
  afterAll(() => {
    if (prevPath === undefined) delete process.env.CLAUDE_CODE_PATH;
    else process.env.CLAUDE_CODE_PATH = prevPath;
  });

  function setup() {
    const db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    const service = new AgentService(db as never, new EventBus());
    const agent = service.createAgent({ name: "Coder", executor_type: "claude_code", model: OPUS, allowed_tools: [] } as never);
    service.setExecutorType(agent.id, "claude_code");
    const run = service.createRun({ agent_id: agent.id, goal: "x" });
    service.updateRun(run.id, { status: "running" });
    return { service, agent: service.getAgent(agent.id)!, run };
  }
  const tried = () => routes.map((r) => `${r.dir === A ? "A" : r.dir === B ? "B" : r.dir}/${r.model}`);
  const runEvents = (service: InstanceType<typeof AgentService>, runId: string) =>
    (service.getEventLog({ run_id: runId }) as Array<{ event_subtype: string; raw_data: string }>)
      .map((e) => ({ subtype: e.event_subtype, raw: e.raw_data ? JSON.parse(e.raw_data) : null }));

  it("continues on the next account with the same model", async () => {
    limitedRoutes.add(`${A}|${OPUS}`);
    const { service, agent, run } = setup();
    const bus = new EventBus();
    const switches: Array<Record<string, unknown>> = [];
    bus.on("agent:flow:model_fallback", (p) => { switches.push(p as Record<string, unknown>); });
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, events: bus });
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS]);
    expect(result.status).toBe("completed");
    expect(result.result).toBe(`hola desde ${OPUS}`);
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ from_model: OPUS, to_model: OPUS, from_account: "Work", to_account: "b@example.com" });
    const events = runEvents(service, run.id);
    expect(events.find((e) => e.subtype === "claude_account")?.raw).toEqual({ account: "Work" });
    expect(events.find((e) => e.subtype === "model_fallback")?.raw).toMatchObject({ from: OPUS, to: OPUS, from_account: "Work", to_account: "b@example.com" });
  }, 30_000);

  it("moves to the fallback model only once every account is limited on the requested one", async () => {
    limitedRoutes.add(`${A}|${OPUS}`);
    limitedRoutes.add(`${B}|${OPUS}`);
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS, "A/" + FABLE]);
    expect(result.status).toBe("completed");
    expect(result.result).toBe(`hola desde ${FABLE}`);
  }, 30_000);

  it("starts the next run on the account still free, and goes back to the primary once it resets", async () => {
    resetsAtOverride = Date.now() + 60_000;
    limitedRoutes.add(`${A}|${OPUS}`);
    const first = setup();
    await new ClaudeCodeExecutor().execute({ agent: first.agent, goal: "x", run: first.run, service: first.service });
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS]);

    routes.length = 0;
    const second = setup();
    const bus = new EventBus();
    const switches: Array<Record<string, unknown>> = [];
    bus.on("agent:flow:model_fallback", (p) => { switches.push(p as Record<string, unknown>); });
    await new ClaudeCodeExecutor().execute({ agent: second.agent, goal: "x", run: second.run, service: second.service, events: bus });
    expect(tried()).toEqual(["B/" + OPUS]);
    // Starting away from the primary is reported like any other switch.
    expect(switches[0]).toMatchObject({ from_model: OPUS, to_model: OPUS, from_account: "Work", to_account: "b@example.com" });

    limitedRoutes.clear();
    // Past A's reset time: the remembered limit lifts by itself.
    setSystemTime(new Date(Date.now() + 120_000));
    try {
      routes.length = 0;
      const third = setup();
      const result = await new ClaudeCodeExecutor().execute({ agent: third.agent, goal: "x", run: third.run, service: third.service });
      expect(tried()).toEqual(["A/" + OPUS]);
      expect(result.status).toBe("completed");
    } finally {
      setSystemTime();
    }
  }, 30_000);

  it("does not restart on another account after work was done", async () => {
    partialRoutes.add(`${A}|${OPUS}`);
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, allowProviderFallback: true });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("429 usage limit");
    expect(tried()).toEqual(["A/" + OPUS]);
  }, 30_000);

  it("keeps the pasted token on the primary and never sends it with another account", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok-primary";
    setClaudePrimaryTokenProbe(() => true);
    limitedRoutes.add(`${A}|${OPUS}`);
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("completed");
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS]);
    expect(routes[0]!.token).toBe("tok-primary");
    expect(routes[1]!.token).toBeUndefined();
  }, 30_000);

  it("prepares the sandbox again on the account it moves to, without the primary's token", async () => {
    setClaudePrimaryTokenProbe(() => true);
    limitedRoutes.add(`${A}|${OPUS}`);
    const prepared: Array<{ account: string | undefined; token: string | undefined }> = [];
    const cleaned: string[] = [];
    const registry = {
      hasFactory: () => true,
      getDriver: () => ({}),
      getAvailableSlugs: () => ["fake"],
      async prepareRun(_slug: string, opts: { claudeAccountId?: string; env: Record<string, string | undefined> }) {
        prepared.push({ account: opts.claudeAccountId, token: opts.env.CLAUDE_CODE_OAUTH_TOKEN });
        return { executablePath: "/bin/sh", instanceId: `i${prepared.length}`, driver: "fake", startedAt: "" };
      },
      async cleanup(h: { instanceId: string }) { cleaned.push(h.instanceId); },
    };
    const { service, agent, run } = setup();
    const executor = new ClaudeCodeExecutor();
    executor.setSandboxRegistry(registry as never);
    const sandboxed = { ...agent, variables: JSON.stringify({ __sandbox_driver__: "fake", __env__: JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: "tok-primary" }) }) };
    const result = await executor.execute({ agent: sandboxed, goal: "x", run, service });
    expect(result.status).toBe("completed");
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS]);
    expect(prepared).toEqual([{ account: "A", token: "tok-primary" }, { account: "B", token: undefined }]);
    expect(cleaned).toEqual(["i1", "i2"]);
  }, 30_000);

  it("leaves a backup account whose session is dead and finishes on the primary's fallback model", async () => {
    limitedRoutes.add(`${A}|${OPUS}`);
    deadDirs.add(B);
    const first = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent: first.agent, goal: "x", run: first.run, service: first.service, allowProviderFallback: true });
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS, "A/" + FABLE]);
    expect(result.status).toBe("completed");
    expect(result.result).toBe(`hola desde ${FABLE}`);
    expect(limits.isClaudeAccountDown("B")).toBe(true);
    const down = runEvents(first.service, first.run.id).find((e) => e.subtype === "claude_account_down");
    expect(down?.raw).toMatchObject({ account: "b@example.com" });

    // While it is down, the next run does not even try it.
    routes.length = 0;
    const second = setup();
    const again = await new ClaudeCodeExecutor().execute({ agent: second.agent, goal: "x", run: second.run, service: second.service });
    expect(tried()).toEqual(["A/" + FABLE]);
    expect(again.status).toBe("completed");
  }, 30_000);

  it("leaves a backup account whose CLI reports a dead session in its result", async () => {
    limitedRoutes.add(`${A}|${OPUS}`);
    resultDeadDirs.add(B);
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS, "A/" + FABLE]);
    expect(result.status).toBe("completed");
    expect(result.result).toBe(`hola desde ${FABLE}`);
  }, 30_000);

  it("handles a dead session on the primary exactly as before", async () => {
    deadDirs.add(A);
    const first = setup();
    await expect(
      new ClaudeCodeExecutor().execute({ agent: first.agent, goal: "x", run: first.run, service: first.service, allowProviderFallback: true }),
    ).rejects.toBeInstanceOf((await import("../src/sdk/claude-access.js")).ClaudeAccessError);
    expect(tried()).toEqual(["A/" + OPUS]);
    expect(limits.isClaudeAccountDown("A")).toBe(false);

    routes.length = 0;
    const second = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent: second.agent, goal: "x", run: second.run, service: second.service });
    expect(result.status).toBe("failed");
    expect(result.error).toContain(DEAD_SESSION);
    expect(tried()).toEqual(["A/" + OPUS]);
  }, 30_000);

  it("does not move on once the run was cancelled", async () => {
    limitedRoutes.add(`${A}|${OPUS}`);
    const { service, agent, run } = setup();
    const executor = new ClaudeCodeExecutor();
    // Cancelled after the limit notice arrived, before the rotation.
    onQueryEnd = () => { executor.cancelRun(run.id); };
    const result = await executor.execute({ agent, goal: "x", run, service });
    expect(tried()).toEqual(["A/" + OPUS]);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("429 usage limit");
  }, 30_000);

  it("ends with the usage limit when the sandbox cannot be prepared on the next account", async () => {
    limitedRoutes.add(`${A}|${OPUS}`);
    let prepares = 0;
    const registry = {
      hasFactory: () => true,
      getDriver: () => ({}),
      getAvailableSlugs: () => ["fake"],
      async prepareRun() {
        prepares++;
        if (prepares > 1) throw new Error("no session for B");
        return { executablePath: "/bin/sh", instanceId: `i${prepares}`, driver: "fake", startedAt: "" };
      },
      async cleanup() {},
    };
    const sandboxed = (a: ReturnType<typeof setup>["agent"]) => ({ ...a, variables: JSON.stringify({ __sandbox_driver__: "fake" }) });
    const first = setup();
    const executor = new ClaudeCodeExecutor();
    executor.setSandboxRegistry(registry as never);
    const result = await executor.execute({ agent: sandboxed(first.agent), goal: "x", run: first.run, service: first.service });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("429 usage limit");
    expect(tried()).toEqual(["A/" + OPUS]);

    limits.clearClaudeLimits();
    routes.length = 0;
    prepares = 0;
    const second = setup();
    await expect(
      executor.execute({ agent: sandboxed(second.agent), goal: "x", run: second.run, service: second.service, allowProviderFallback: true }),
    ).rejects.toBeInstanceOf(limits.ClaudeUsageLimitError);
  }, 30_000);

  it("fails with the limit when every account and model is out", async () => {
    limitedModels.add(OPUS);
    limitedModels.add(FABLE);
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("failed");
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS, "A/" + FABLE, "B/" + FABLE]);
    expect(result.error).toMatch(/429 usage limit reached on claude-fable-5-1/);
  }, 30_000);
});


describe("claude_code agent passes in the LIVE pill", () => {
  const OPUS = "claude-opus-5-5";
  const FABLE = "claude-fable-5-1";
  const prevPath = process.env.CLAUDE_CODE_PATH;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  let xdg = "";
  let A = "";
  let B = "";
  // What the registry held at the end of each pass, while the pass still ran.
  const seen: Array<Array<{ slug: string; model?: string; caller?: string }>> = [];

  beforeEach(() => {
    clearInFlight();
    seen.length = 0;
    process.env.CLAUDE_CODE_PATH = "/bin/sh";
    xdg = mkdtempSync(join(tmpdir(), "claude-exec-inflight-"));
    process.env.XDG_CONFIG_HOME = xdg;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    setClaudePrimaryTokenProbe(() => false);
    setClaudeAccountResolver(() => [{ id: "A", label: "Work" }, { id: "B", label: "" }]);
    A = claudeAccountDir("A");
    B = claudeAccountDir("B");
    for (const dir of [A, B]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".credentials.json"), "{}");
    }
    onQueryEnd = () => { seen.push(listInFlight().map(({ slug, model, caller }) => ({ slug, model, caller }))); };
  });
  afterEach(() => {
    setClaudeAccountResolver(null);
    setClaudePrimaryTokenProbe(null);
    rmSync(xdg, { recursive: true, force: true });
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
  });
  afterAll(() => {
    if (prevPath === undefined) delete process.env.CLAUDE_CODE_PATH;
    else process.env.CLAUDE_CODE_PATH = prevPath;
  });

  function setup() {
    const db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    const service = new AgentService(db as never, new EventBus());
    const agent = service.createAgent({ name: "Coder", executor_type: "claude_code", model: OPUS, allowed_tools: [] } as never);
    service.setExecutorType(agent.id, "claude_code");
    const run = service.createRun({ agent_id: agent.id, goal: "x" });
    service.updateRun(run.id, { status: "running" });
    return { service, agent: service.getAgent(agent.id)!, run };
  }
  const entry = (model: string) => [{ slug: "claude-code", model, caller: "agent:Coder" }];

  it("lists a completed run while it runs, and not after", async () => {
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("completed");
    expect(seen).toEqual([entry(OPUS)]);
    expect(listInFlight()).toHaveLength(0);
  }, 30_000);

  it("lists one entry per account/model pass of a run the limit moves around", async () => {
    limitedRoutes.add(`${A}|${OPUS}`);
    limitedRoutes.add(`${B}|${OPUS}`);
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("completed");
    expect(seen).toEqual([entry(OPUS), entry(OPUS), entry(FABLE)]);
    expect(listInFlight()).toHaveLength(0);
  }, 30_000);

  it("clears the entry when the limit cuts the run", async () => {
    limitedModels.add(OPUS);
    limitedModels.add(FABLE);
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("failed");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.length === 1)).toBe(true);
    expect(listInFlight()).toHaveLength(0);
  }, 30_000);

  it("clears the entry when the pass throws", async () => {
    deadDirs.add(A);
    const { service, agent, run } = setup();
    await expect(
      new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, allowProviderFallback: true }),
    ).rejects.toBeInstanceOf((await import("../src/sdk/claude-access.js")).ClaudeAccessError);
    expect(listInFlight()).toHaveLength(0);
  }, 30_000);
});

describe("Claude limit diagnostics", () => {
  it("reports the subscription notice for the short model alias too", () => {
    limits.rememberClaudeLimit("claude-sonnet-5-5", { kind: "rate_limit", detail: "weekly quota exhausted", resetsAt: RESETS_S * 1000 });
    expect(limits.getClaudeModelLimit("sonnet")).toMatchObject({ detail: "weekly quota exhausted", resetsAt: RESETS_S * 1000 });
    expect(limits.getClaudeModelLimit("haiku")).toBeNull();
  });
});

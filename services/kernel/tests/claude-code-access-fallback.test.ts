import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

// What the SDK throws when the CLI's subscription session cannot be used at
// all: the organization turned subscription access off, the OAuth session
// died, or nobody is logged in. Unlike a usage limit, no model of the
// subscription can run, so the only way forward is another provider.
const ORG_DISABLED =
  "Claude Code returned an error result: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

let failWith: string | null = null;
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
    const error = failWith;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "s" };
        if (error) throw new Error(error);
        yield { type: "assistant", message: { content: [{ type: "text", text: "hola" }] } };
        yield { type: "result", subtype: "success", is_error: false, result: "hola" };
      },
      close() {},
    };
  },
}));

const access = await import("../src/sdk/claude-access.js");
const { ClaudeCodeExecutor } = await import("../assets/extensions/agents/agent-advanced/_module/claude-code-executor.js");
const { AgentExecutor } = await import("../src/modules/agents/executor.js");
const { runMigrations } = await import("../src/core/db/migrations.js");
const { agentsMigrations } = await import("../src/modules/agents/migrations.js");
const { AgentService } = await import("../src/modules/agents/service.js");
const { EventBus } = await import("../src/core/event-bus.js");

const prevPath = process.env.CLAUDE_CODE_PATH;
afterAll(() => {
  active = false;
  if (prevPath === undefined) delete process.env.CLAUDE_CODE_PATH;
  else process.env.CLAUDE_CODE_PATH = prevPath;
});

beforeEach(() => {
  failWith = ORG_DISABLED;
  calls.length = 0;
});

describe("isClaudeAccessError", () => {
  it("recognizes a subscription the CLI can no longer use", () => {
    expect(access.isClaudeAccessError(ORG_DISABLED)).toBe(true);
    expect(access.isClaudeAccessError("Claude Code returned an error result: Failed to authenticate. API Error: 401")).toBe(true);
    expect(access.isClaudeAccessError("Invalid API key · Please run /login")).toBe(true);
    expect(access.isClaudeAccessError("OAuth token has expired and could not be refreshed")).toBe(true);
  });

  it("is an auth failure for provider health, so the chain shows it as such", async () => {
    const { classifyError } = await import("../src/core/llm/provider-health.js");
    expect(classifyError(new Error(ORG_DISABLED))).toBe("auth");
  });

  it("leaves limits, refusals and ordinary failures to their own handling", () => {
    expect(access.isClaudeAccessError("You've hit your limit · resets Oct 18")).toBe(false);
    expect(access.isClaudeAccessError("API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy")).toBe(false);
    expect(access.isClaudeAccessError("Claude Code process exited with code 1")).toBe(false);
    expect(access.isClaudeAccessError("")).toBe(false);
  });
});

type AgentInput = { allowed_tools?: string[]; model_chain?: Array<{ provider: string; model: string }> };

function setup(input: AgentInput = {}) {
  process.env.CLAUDE_CODE_PATH = "/bin/sh";
  const db = new Database(":memory:");
  runMigrations(db as never, "agents", agentsMigrations);
  const service = new AgentService(db as never, new EventBus());
  const created = service.createAgent({
    name: "Worker",
    executor_type: "claude_code",
    model: "claude-sonnet-5-5",
    allowed_tools: input.allowed_tools ?? [],
  } as never);
  service.setExecutorType(created.id, "claude_code");
  if (input.model_chain) service.setModelChain(created.id, input.model_chain as never);
  const run = service.createRun({ agent_id: created.id, goal: "x" });
  service.updateRun(run.id, { status: "running" });
  return { service, agent: service.getAgent(created.id)!, run };
}

/** A provider that answers once and records which model it was asked for. */
function backup(name: string, seen: string[]) {
  return {
    name,
    available: () => true,
    getDefaultModel: () => `${name}-default`,
    async chatCompletion(_messages: unknown, options: { model?: string }) {
      seen.push(`${name}/${options.model}`);
      return { content: `done on ${name}`, tokens_used: 3, model: options.model };
    },
  };
}

function executorWith(providers: Array<[string, ReturnType<typeof backup>]>, globalChain: Array<{ provider: string; model: string }>) {
  const executor = new AgentExecutor();
  executor.setClaudeCodeExecutor(new ClaudeCodeExecutor());
  executor.setConfig({ language: "en", agents: { defaultModelChain: globalChain } } as never);
  executor.setProviders(new Map(providers) as never, providers[0]?.[0] ?? "");
  return executor;
}

describe("claude_code run when the subscription cannot be used", () => {
  it("hands off to the provider chain instead of failing the run", async () => {
    const { service, agent, run } = setup({ allowed_tools: ["kernel_notes_create"] });
    await expect(
      new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, allowProviderFallback: true }),
    ).rejects.toBeInstanceOf(access.ClaudeAccessError);
  }, 30_000);

  it("still fails with the real reason when no fallback was allowed", async () => {
    const { service, agent, run } = setup({ allowed_tools: ["kernel_notes_create"] });
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("disabled Claude subscription access");
  }, 30_000);

  it("runs an agent that only uses kernel tools on the global chain", async () => {
    const { service, agent, run } = setup({ allowed_tools: ["kernel_notes_create"] });
    const seen: string[] = [];
    const executor = executorWith([["openai", backup("openai", seen)]], [{ provider: "openai", model: "gpt-5-nano" }]);
    const events = new EventBus();
    const switches: unknown[] = [];
    events.on("agent:flow:fallback_used", (p) => { switches.push(p); });
    const result = await executor.execute({ agent, goal: "x", run, service, events });
    expect(result.status).toBe("completed");
    expect(result.result).toBe("done on openai");
    expect(seen).toEqual(["openai/gpt-5-nano"]);
    expect(switches[0]).toMatchObject({ from_provider: "claude_code", to_provider: "openai" });
    expect(service.getAgent(agent.id)?.executor_type).toBe("claude_code");
  }, 30_000);

  it("prefers the same Claude model through an Anthropic API key", async () => {
    const { service, agent, run } = setup({ allowed_tools: ["kernel_notes_create"] });
    const seen: string[] = [];
    const executor = executorWith(
      [["openai", backup("openai", seen)], ["claude", backup("claude", seen)]],
      [{ provider: "openai", model: "gpt-5-nano" }],
    );
    const result = await executor.execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("completed");
    expect(seen).toEqual(["claude/claude-sonnet-5-5"]);
  }, 30_000);

  it("keeps a coding agent waiting for the reconnection instead of handing its repo to a weaker model", async () => {
    const { service, agent, run } = setup({ allowed_tools: ["Bash", "Read", "Grep"] });
    const seen: string[] = [];
    const executor = executorWith([["openai", backup("openai", seen)]], [{ provider: "openai", model: "gpt-5-nano" }]);
    const result = await executor.execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("failed");
    expect(result.error).toContain(access.CLAUDE_ACCESS_WAITING);
    expect(seen).toEqual([]);
  }, 30_000);

  it("treats an agent with no tool list as a coding agent", async () => {
    const { service, agent, run } = setup();
    const seen: string[] = [];
    const executor = executorWith([["openai", backup("openai", seen)]], [{ provider: "openai", model: "gpt-5-nano" }]);
    const result = await executor.execute({ agent, goal: "x", run, service });
    expect(result.error).toContain(access.CLAUDE_ACCESS_WAITING);
    expect(seen).toEqual([]);
  }, 30_000);

  it("lets a coding agent fall back to a model its own chain names", async () => {
    const { service, agent, run } = setup({
      allowed_tools: ["Bash", "Read"],
      model_chain: [{ provider: "claude_code", model: "claude-sonnet-5-5" }, { provider: "grok", model: "grok-4-fast-reasoning" }],
    });
    const seen: string[] = [];
    const executor = executorWith(
      [["openai", backup("openai", seen)], ["grok", backup("grok", seen)]],
      [{ provider: "openai", model: "gpt-5-nano" }],
    );
    const cli = new ClaudeCodeExecutor();
    cli.prepareNativeFallbackTools = async () => ({ tools: [], cleanup: async () => {}, prompt: "" });
    executor.setClaudeCodeExecutor(cli);
    const result = await executor.execute({ agent, goal: "x", run, service });
    expect(seen[0]).toBe("grok/grok-4-fast-reasoning");
    expect(seen).not.toContain("openai/gpt-5-nano");
    expect(result.error ?? "").not.toContain(access.CLAUDE_ACCESS_WAITING);
  }, 30_000);
});

describe("auto-pause while Claude access is lost", () => {
  it("does not count the run as a strike", () => {
    const { service, agent } = setup({ allowed_tools: ["Bash"] });
    for (let i = 0; i < 5; i++) {
      service.recordRunOutcome(agent.id, { ok: false, error: `${access.CLAUDE_ACCESS_WAITING} ${ORG_DISABLED}` });
    }
    const after = service.getAgent(agent.id)!;
    expect(after.consecutive_failures ?? 0).toBe(0);
    expect(after.active).toBe(1);
  });

  it("still counts every other failure", () => {
    const { service, agent } = setup({ allowed_tools: ["Bash"] });
    service.recordRunOutcome(agent.id, { ok: false, error: "Claude Code process exited with code 1" });
    expect(service.getAgent(agent.id)!.consecutive_failures).toBe(1);
  });
});

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The kernel stopped reading a CLI's stdout mid-run (19/11): the SDK's
// iterator then waits forever on its next message. These queries reproduce
// that: after their messages they never yield again, and only `close()` —
// what the SDK's own cleanup does — ends them.
type Msg = Record<string, unknown>;
let script: Msg[] = [];
const seen: Array<{ options: Record<string, unknown> }> = [];
let closes = 0;
let active = true;
const real = await import("@anthropic-ai/claude-agent-sdk");
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...real,
  query: (args: Parameters<typeof real.query>[0]) => {
    if (!active) return real.query(args);
    seen.push({ options: args.options as Record<string, unknown> });
    const msgs = [...script];
    let release: (() => void) | null = null;
    let closed = false;
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of msgs) yield m;
        // Stalled: no message, no end, until closed.
        await new Promise<void>((r) => { release = r; if (closed) r(); });
      },
      close() { closes++; closed = true; release?.(); },
    };
  },
}));

const { ClaudeCodeExecutor } = await import("../assets/extensions/agents/agent-advanced/_module/claude-code-executor.js");
const { runMigrations } = await import("../src/core/db/migrations.js");
const { agentsMigrations } = await import("../src/modules/agents/migrations.js");
const { AgentService } = await import("../src/modules/agents/service.js");
const { EventBus } = await import("../src/core/event-bus.js");
const { settleClaudeStream, spawnClaudeCodeWithFileStdio } = await import("../src/sdk/claude-stream.js");

const prevPath = process.env.CLAUDE_CODE_PATH;
const prevGrace = process.env.KERNEL_CLAUDE_STREAM_AFTER_RESULT_MS;
afterAll(() => {
  active = false;
  if (prevPath === undefined) delete process.env.CLAUDE_CODE_PATH; else process.env.CLAUDE_CODE_PATH = prevPath;
  if (prevGrace === undefined) delete process.env.KERNEL_CLAUDE_STREAM_AFTER_RESULT_MS;
  else process.env.KERNEL_CLAUDE_STREAM_AFTER_RESULT_MS = prevGrace;
});

beforeEach(() => {
  script = [];
  seen.length = 0;
  closes = 0;
  delete process.env.KERNEL_CLAUDE_STREAM_AFTER_RESULT_MS;
});

function setup() {
  process.env.CLAUDE_CODE_PATH = "/bin/sh";
  const db = new Database(":memory:");
  runMigrations(db as never, "agents", agentsMigrations);
  const service = new AgentService(db as never, new EventBus());
  const agent = service.createAgent({ name: "Reviewer", executor_type: "claude_code", model: "claude-sonnet-5-5", allowed_tools: [] } as never);
  service.setExecutorType(agent.id, "claude_code");
  const run = service.createRun({ agent_id: agent.id, goal: "x" });
  service.updateRun(run.id, { status: "running" });
  return { service, agent: service.getAgent(agent.id)!, run };
}

/** Settles with "hung" when `p` has not settled in `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | "hung"> {
  return Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);
}

const midRun: Msg[] = [
  { type: "system", subtype: "init", session_id: "s-1" },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
];
const finished: Msg[] = [
  ...midRun,
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "LGTM" }] } },
  { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "LGTM", usage: { input_tokens: 10, output_tokens: 5 } },
];

describe("a claude_code run whose stream stops", () => {
  it("is ended by agents.stop: execute() resolves although no message ever comes", async () => {
    script = midRun;
    const { service, agent, run } = setup();
    const exec = new ClaudeCodeExecutor();
    const done = exec.execute({ agent, goal: "x", run, service });
    // Let the run reach the stalled step.
    for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    expect(exec.getActiveRunIds()).toContain(run.id);
    expect(exec.cancelRun(run.id)).toBe(true);
    const result = await within(done, 3_000);
    expect(result).not.toBe("hung");
    expect(closes).toBeGreaterThan(0);
    expect(exec.getActiveRunIds()).not.toContain(run.id);
  }, 10_000);

  it("finishes with the CLI's result when the stream does not end after it", async () => {
    process.env.KERNEL_CLAUDE_STREAM_AFTER_RESULT_MS = "100";
    script = finished;
    const { service, agent, run } = setup();
    const result = await within(new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service }), 3_000);
    expect(result).not.toBe("hung");
    if (result === "hung") return;
    expect(result.status).toBe("completed");
    expect(result.result).toBe("LGTM");
    expect(closes).toBeGreaterThan(0);
  }, 10_000);

  it("runs the CLI with stdio the kernel reads from files", async () => {
    script = finished;
    process.env.KERNEL_CLAUDE_STREAM_AFTER_RESULT_MS = "50";
    const { service, agent, run } = setup();
    await within(new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service }), 3_000);
    expect(typeof seen[0]?.options.spawnClaudeCodeProcess).toBe("function");
  }, 10_000);
});

describe("settleClaudeStream", () => {
  const stalled = (msgs: Msg[]) => {
    let release: (() => void) | null = null;
    let closedCount = 0;
    return {
      get closedCount() { return closedCount; },
      async *[Symbol.asyncIterator]() {
        for (const m of msgs) yield m;
        await new Promise<void>((r) => { release = r; });
      },
      close() { closedCount++; release?.(); },
    };
  };

  it("passes a stream that ends through untouched", async () => {
    const src = { async *[Symbol.asyncIterator]() { yield { type: "a" }; yield { type: "result" }; } };
    const got: string[] = [];
    for await (const m of settleClaudeStream(src)) got.push(m.type);
    expect(got).toEqual(["a", "result"]);
  });

  it("stops waiting when the signal aborts", async () => {
    const src = stalled([{ type: "system" }]);
    const ctrl = new AbortController();
    const cuts: string[] = [];
    const got: string[] = [];
    const loop = (async () => {
      for await (const m of settleClaudeStream(src, { signal: ctrl.signal, onCut: (w) => cuts.push(w) })) got.push(String(m.type));
    })();
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();
    expect(await within(loop, 1_000)).not.toBe("hung");
    expect(got).toEqual(["system"]);
    expect(cuts).toEqual(["aborted"]);
    expect(src.closedCount).toBeGreaterThan(0);
  });

  it("closes a stream still open after its result", async () => {
    const src = stalled([{ type: "assistant" }, { type: "result" }]);
    const cuts: string[] = [];
    const loop = (async () => {
      for await (const _ of settleClaudeStream(src, { afterResultMs: 30, onCut: (w) => cuts.push(w) })) { /* drain */ }
    })();
    expect(await within(loop, 1_000)).not.toBe("hung");
    expect(cuts).toEqual(["no_end_after_result"]);
  });

  it("does not hang a consumer that breaks out of a stalled stream", async () => {
    const src = stalled([{ type: "a" }]);
    const loop = (async () => { for await (const _ of settleClaudeStream(src)) break; })();
    expect(await within(loop, 1_000)).not.toBe("hung");
  });
});

describe("spawnClaudeCodeWithFileStdio", () => {
  const dir = mkdtempSync(join(tmpdir(), "kernl-stdio-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const lines = async (p: ReturnType<typeof spawnClaudeCodeWithFileStdio>) => {
    let text = "";
    for await (const chunk of p.stdout) text += String(chunk);
    return text.split("\n").filter(Boolean);
  };

  it("delivers everything the child wrote, then its exit, and leaves no files", async () => {
    const stderr: string[] = [];
    const p = spawnClaudeCodeWithFileStdio({
      command: "/bin/sh",
      args: ["-c", 'read line; echo "{\\"got\\":\\"$line\\"}"; i=0; while [ $i -lt 2000 ]; do echo "{\\"i\\":$i}"; i=$((i+1)); done; echo oops >&2'],
      env: { ...process.env },
      signal: new AbortController().signal,
    }, { dir, pollMs: 10, onStderr: (t) => stderr.push(t) });
    const exit = new Promise<number | null>((r) => p.once("exit", (code) => r(code)));
    p.stdin.write("hello\n");
    p.stdin.end();
    const out = await lines(p);
    expect(out[0]).toBe('{"got":"hello"}');
    expect(out.length).toBe(2001);
    expect(out.at(-1)).toBe('{"i":1999}');
    expect(await exit).toBe(0);
    expect(p.exitCode).toBe(0);
    expect(stderr.join("")).toBe("oops\n");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("is killed when the SDK's signal aborts", async () => {
    const ctrl = new AbortController();
    const p = spawnClaudeCodeWithFileStdio({ command: "/bin/sh", args: ["-c", "sleep 30"], env: { ...process.env }, signal: ctrl.signal }, { dir, pollMs: 10 });
    const exit = new Promise<string | null>((r) => p.once("exit", (_c, sig) => r(sig)));
    ctrl.abort();
    expect(await within(exit, 3_000)).toBe("SIGTERM");
  });
});

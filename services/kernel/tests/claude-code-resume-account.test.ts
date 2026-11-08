import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stage 2: a run cut by the usage limit after doing work resumes the same CLI
// conversation on the next account instead of being cut.

const OPUS = "claude-opus-5-5";
const SESSION = "0b6c7a1e-3f4d-4c2b-9a8e-5d6f7e8a9b0c";
const RESETS_S = Math.floor(Date.UTC(2026, 9, 18, 14) / 1000);
const RESUME_PROMPT =
  "The previous attempt was interrupted by a usage limit. Continue the task from where it stopped. Do not repeat steps that already completed.";

// The CLI's own rule for the per-project transcript dir.
const cliSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const init = (sid: string) => ({ type: "system", subtype: "init", session_id: sid });
const workTurn = { type: "assistant", message: { content: [{ type: "text", text: "work already done" }] } };
const limited = [
  { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: RESETS_S, rateLimitType: "seven_day" } },
  { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your limit · resets Oct 18" }] } },
  { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "You've hit your limit · resets Oct 18" },
];
const answered = (text: string) => [
  { type: "assistant", message: { content: [{ type: "text", text }] } },
  { type: "result", subtype: "success", is_error: false, result: text },
];

type Call = {
  dir: string | undefined;
  model: string;
  prompt: unknown;
  resume: string | undefined;
  cwd: string | undefined;
  persist: boolean;
  transcriptFound: boolean;
};
const calls: Call[] = [];
const partialRoutes = new Set<string>();
const limitedRoutes = new Set<string>();
// Off: the CLI wrote no transcript (or it vanished) before the hand-over.
let writeTranscripts = true;
// Sandboxed runs: the dir the fake driver mounted as the CLI's projects dir.
let sandboxProjects: string | null = null;
// How a resumed call fails, after its init message: a thrown error, or the
// CLI's dead-session answer as text.
let resumeFails: "throw" | "dead-session" | "empty" | null = null;
// Each result message carries this much usage (per model) when set.
let resultUsage: { inputTokens: number; outputTokens: number } | null = null;
const DEAD_SESSION = "OAuth token has expired and could not be refreshed";
// Called once a query has streamed all its messages, e.g. to cancel the run.
let onQueryEnd: (() => void) | null = null;

let active = true;
const real = await import("@anthropic-ai/claude-agent-sdk");
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...real,
  query: (args: Parameters<typeof real.query>[0]) => {
    if (!active) return real.query(args);
    const options = args.options as {
      model: string; cwd?: string; resume?: string; persistSession?: boolean;
      env?: Record<string, string | undefined>;
    };
    const dir = options.env?.CLAUDE_CONFIG_DIR;
    const persist = options.persistSession !== false;
    // Where this CLI keeps its transcripts: the account's dir, or the mounted
    // per-run dir inside a sandbox (cwd /workspace there).
    const projects = sandboxProjects ?? (dir ? join(dir, "projects") : null);
    const slug = cliSlug(sandboxProjects ? "/workspace" : options.cwd ?? "");
    const file = (sid: string) => (projects ? join(projects, slug, `${sid}.jsonl`) : "");
    const transcriptFound = !!options.resume && existsSync(file(options.resume));
    calls.push({ dir, model: options.model, prompt: args.prompt, resume: options.resume, cwd: options.cwd, persist, transcriptFound });
    const key = `${dir}|${options.model}`;
    const sid = options.resume ?? SESSION;
    const msgs: unknown[] = [init(sid)];
    if (options.resume && !transcriptFound) throw new Error(`No conversation found with session ID: ${options.resume}`);
    if (options.resume && resumeFails === "throw") {
      return {
        async *[Symbol.asyncIterator]() {
          yield init(sid);
          throw new Error("Claude Code process exited with code 1");
        },
        close() {},
      };
    }
    if (options.resume && resumeFails === "empty") {
      msgs.push({ type: "result", subtype: "success", is_error: false, result: "" });
    } else if (options.resume && resumeFails === "dead-session") {
      msgs.push(
        { type: "assistant", message: { content: [{ type: "text", text: DEAD_SESSION }] } },
        { type: "result", subtype: "error_during_execution", is_error: true, errors: [DEAD_SESSION] },
      );
    } else if (partialRoutes.has(key)) msgs.push(workTurn, ...limited);
    else if (limitedRoutes.has(key)) msgs.push(...limited);
    else msgs.push(...answered(`hola desde ${options.model}`));
    if (resultUsage) {
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i] as { type?: string };
        if (m.type === "result") msgs[i] = { ...m, modelUsage: { [options.model]: { ...resultUsage } } };
      }
    }
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of msgs) {
          // The CLI appends each message to the transcript as it goes.
          if (persist && writeTranscripts && projects) {
            mkdirSync(join(projects, slug), { recursive: true });
            writeFileSync(file(sid), JSON.stringify(m) + "\n", { flag: "a" });
          }
          yield m;
        }
        onQueryEnd?.();
      },
      close() {},
    };
  },
}));

const limits = await import("../src/sdk/claude-limits.js");
const { setClaudeAccountResolver, setClaudePrimaryTokenProbe, claudeAccountDir } = await import("../src/sdk/claude-accounts.js");
const { ClaudeCodeExecutor } = await import("../assets/extensions/agents/agent-advanced/_module/claude-code-executor.js");
const resume = await import("../assets/extensions/agents/agent-advanced/_module/claude-resume.js");
const { sandboxTranscriptLines, SANDBOX_TRANSCRIPTS_PATH } = await import("../src/core/sandbox/driver.js");
const { DockerSandboxDriver } = await import("../src/core/sandbox/drivers/docker-driver.js");
const { runMigrations } = await import("../src/core/db/migrations.js");
const { agentsMigrations } = await import("../src/modules/agents/migrations.js");
const { AgentService } = await import("../src/modules/agents/service.js");
const { EventBus } = await import("../src/core/event-bus.js");
const { getHost, installedHost, setHost } = await import("../src/sdk/host.js");

afterAll(() => { active = false; });

describe("transcript paths", () => {
  it("follow the CLI's per-project dir name", () => {
    expect(resume.transcriptPath("/cfg", "/app/data/workspaces/ab_c.d", "s1"))
      .toBe("/cfg/projects/-app-data-workspaces-ab-c-d/s1.jsonl");
    expect(resume.transcriptPath("/cfg", "/workspace", "s1")).toBe("/cfg/projects/-workspace/s1.jsonl");
  });

  it("shorten a long dir name the way the CLI does", () => {
    const cwd = "/" + "x".repeat(250);
    // The CLI: first 200 chars, then a base-36 hash of the raw path.
    let h = 0;
    for (let i = 0; i < cwd.length; i++) h = (h << 5) - h + cwd.charCodeAt(i) | 0;
    const expected = `${cliSlug(cwd).slice(0, 200)}-${Math.abs(h).toString(36)}`;
    expect(resume.transcriptPath("/cfg", cwd, "s1")).toBe(`/cfg/projects/${expected}/s1.jsonl`);
  });

  it("hand a transcript over to another account's dir, and refuse an unsafe session id", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-resume-paths-"));
    try {
      const from = join(root, "a");
      const to = join(root, "b");
      mkdirSync(join(from, "projects", "-w"), { recursive: true });
      writeFileSync(join(from, "projects", "-w", "s1.jsonl"), "{}\n");
      expect(resume.handOverTranscript(from, to, "/w", "s1")).toBe(true);
      expect(existsSync(join(to, "projects", "-w", "s1.jsonl"))).toBe(true);
      expect(resume.handOverTranscript(from, to, "/w", "missing")).toBe(false);
      expect(resume.handOverTranscript(from, to, "/w", "../../etc/passwd")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("leftover sandbox transcript dirs", () => {
  it("are all removed by the boot sweep, and a missing root is fine", () => {
    const data = mkdtempSync(join(tmpdir(), "claude-resume-sweep-"));
    try {
      const root = resume.transcriptRunsRoot(join(data, "kernel.db"));
      expect(root).toBe(join(data, ".claude-transcripts"));
      expect(resume.sweepTranscriptRunDirs(root)).toBe(0);
      mkdirSync(join(root, "run-1", "-workspace"), { recursive: true });
      writeFileSync(join(root, "run-1", "-workspace", "s.jsonl"), "{}\n");
      mkdirSync(join(root, "run-2"), { recursive: true });
      expect(resume.sweepTranscriptRunDirs(root)).toBe(2);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe("sandbox transcripts", () => {
  it("know the uid the docker sandbox writes as", () => {
    const driver = new DockerSandboxDriver();
    expect(driver.sandboxUid()).toBe(1000);
    driver.configure({ runAs: "1234:1234" });
    expect(driver.sandboxUid()).toBe(1234);
  });

  it("link the CLI's projects dir to the mounted per-run dir, and add nothing without one", () => {
    expect(sandboxTranscriptLines(undefined)).toEqual([]);
    const lines = sandboxTranscriptLines("/app/data/.claude-transcripts/r1").join("\n");
    expect(lines).toContain(`ln -s ${SANDBOX_TRANSCRIPTS_PATH} "$HOME/.claude/projects"`);
  });
});

describe("claude_code run resumed on the next account", () => {
  const prevPath = process.env.CLAUDE_CODE_PATH;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const prevSqlite = process.env.SQLITE_PATH;
  let xdg = "";
  let A = "";
  let B = "";

  beforeEach(() => {
    limits.clearClaudeLimits();
    calls.length = 0;
    partialRoutes.clear();
    limitedRoutes.clear();
    writeTranscripts = true;
    sandboxProjects = null;
    onQueryEnd = null;
    resumeFails = null;
    resultUsage = null;
    process.env.CLAUDE_CODE_PATH = "/bin/sh";
    xdg = mkdtempSync(join(tmpdir(), "claude-resume-"));
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.SQLITE_PATH = join(xdg, "data", "kernel.db");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_LIMIT_FALLBACK_MODEL;
    setClaudePrimaryTokenProbe(() => false);
    setClaudeAccountResolver(() => [{ id: "A", label: "Work" }, { id: "B", label: "" }]);
    A = claudeAccountDir("A");
    B = claudeAccountDir("B");
    for (const dir of [A, B]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".credentials.json"), "{}");
    }
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
  const tried = () => calls.map((c) => `${c.dir === A ? "A" : c.dir === B ? "B" : c.dir}/${c.model}`);
  const runEvents = (service: InstanceType<typeof AgentService>, runId: string) =>
    (service.getEventLog({ run_id: runId }) as Array<{ event_subtype: string; raw_data: string }>)
      .map((e) => ({ subtype: e.event_subtype, raw: e.raw_data ? JSON.parse(e.raw_data) : null }));
  const transcriptsLeft = (dir: string) => {
    const projects = join(dir, "projects");
    if (!existsSync(projects)) return [];
    return readdirSync(projects).flatMap((p) => readdirSync(join(projects, p)));
  };

  it("resumes the same conversation on the next account with the same model", async () => {
    partialRoutes.add(`${A}|${OPUS}`);
    const { service, agent, run } = setup();
    const bus = new EventBus();
    const switches: Array<Record<string, unknown>> = [];
    bus.on("agent:flow:model_fallback", (p) => { switches.push(p as Record<string, unknown>); });
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, events: bus });

    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS]);
    expect(calls[0]!.persist).toBe(true);
    expect(calls[0]!.resume).toBeUndefined();
    expect(calls[1]!.resume).toBe(SESSION);
    expect(calls[1]!.transcriptFound).toBe(true);
    expect(calls[1]!.cwd).toBe(calls[0]!.cwd);
    expect(calls[1]!.prompt).toBe(RESUME_PROMPT);
    expect(result.status).toBe("completed");
    expect(result.result).toBe(`hola desde ${OPUS}`);
    // Both passes count: two assistant turns of work.
    expect(result.steps_count).toBeGreaterThanOrEqual(2);
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ from_model: OPUS, to_model: OPUS, from_account: "Work", to_account: "b@example.com", resumed: true });
    expect(runEvents(service, run.id).find((e) => e.subtype === "model_fallback")?.raw)
      .toMatchObject({ from: OPUS, to: OPUS, from_account: "Work", to_account: "b@example.com", resumed: true });
    // Transcripts were not kept before this work; the run leaves none behind.
    expect(transcriptsLeft(A)).toEqual([]);
    expect(transcriptsLeft(B)).toEqual([]);
  }, 30_000);

  it("is cut with the limit, without a second call, when the transcript is missing", async () => {
    partialRoutes.add(`${A}|${OPUS}`);
    writeTranscripts = false;
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, allowProviderFallback: true });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("429 usage limit");
    expect(tried()).toEqual(["A/" + OPUS]);
  }, 30_000);

  it("is cut when the resumed pass hits the limit too, with no third route", async () => {
    partialRoutes.add(`${A}|${OPUS}`);
    limitedRoutes.add(`${B}|${OPUS}`);
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, allowProviderFallback: true });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("429 usage limit");
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS]);
    expect(calls[1]!.resume).toBe(SESSION);
  }, 30_000);

  it("is cut with the limit, not the resume's own error, when the resumed call fails before doing anything", async () => {
    partialRoutes.add(`${A}|${OPUS}`);
    resumeFails = "throw";
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, allowProviderFallback: true });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("429 usage limit");
    expect(result.error).not.toContain("exited with code");
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS]);
    expect(calls[1]!.resume).toBe(SESSION);
  }, 30_000);

  it("is cut with the limit when the resumed pass ends with no output and no error", async () => {
    partialRoutes.add(`${A}|${OPUS}`);
    resumeFails = "empty";
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, allowProviderFallback: true });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("429 usage limit");
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS]);
  }, 30_000);

  it("records the tokens of both passes when the run resumes", async () => {
    partialRoutes.add(`${A}|${OPUS}`);
    resultUsage = { inputTokens: 10, outputTokens: 5 };
    const recorded: Array<{ model: string; inputTokens?: number; outputTokens?: number }> = [];
    const prev = installedHost();
    setHost({ ...getHost(), recordLlmCall: (r: never) => { recorded.push(r); } });
    try {
      const { service, agent, run } = setup();
      const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
      expect(result.status).toBe("completed");
    } finally {
      setHost(prev);
    }
    const mine = recorded.filter((r) => r.model === OPUS && r.inputTokens);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  }, 30_000);

  it("names the account in a step only when there is more than one", async () => {
    const { service, agent, run } = setup();
    await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(runEvents(service, run.id).some((e) => e.subtype === "claude_account")).toBe(true);

    setClaudeAccountResolver(() => [{ id: "A", label: "Work" }]);
    const second = setup();
    await new ClaudeCodeExecutor().execute({ agent: second.agent, goal: "x", run: second.run, service: second.service });
    expect(runEvents(second.service, second.run.id).some((e) => e.subtype === "claude_account")).toBe(false);
  }, 30_000);

  it("marks the next account down when its session is dead on the resume, and is cut with the limit", async () => {
    partialRoutes.add(`${A}|${OPUS}`);
    resumeFails = "dead-session";
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, allowProviderFallback: true });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("429 usage limit");
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS]);
    expect(limits.isClaudeAccountDown("B")).toBe(true);
    expect(runEvents(service, run.id).find((e) => e.subtype === "claude_account_down")?.raw)
      .toMatchObject({ account: "b@example.com" });
  }, 30_000);

  it("never resumes on another model", async () => {
    partialRoutes.add(`${A}|${OPUS}`);
    // B is already known to be out on opus: the only route left is Fable.
    limits.rememberClaudeLimit(OPUS, { kind: "rate_limit", detail: "limit", resetsAt: Date.now() + 3_600_000, limitType: "seven_day_opus" }, Date.now(), "B");
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service, allowProviderFallback: true });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("429 usage limit");
    expect(tried()).toEqual(["A/" + OPUS]);
  }, 30_000);

  it("keeps sessions unpersisted when there is no other account to resume on", async () => {
    setClaudeAccountResolver(() => [{ id: "A", label: "Work" }]);
    partialRoutes.add(`${A}|${OPUS}`);
    const { service, agent, run } = setup();
    const result = await new ClaudeCodeExecutor().execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("failed");
    expect(tried()).toEqual(["A/" + OPUS]);
    expect(calls[0]!.persist).toBe(false);
  }, 30_000);

  it("resumes a sandboxed run from the per-run transcript dir and removes it at the end", async () => {
    partialRoutes.add(`${A}|${OPUS}`);
    const prepared: Array<{ account: string | undefined; transcriptDir: string | undefined; mode: number | null }> = [];
    const registry = {
      hasFactory: () => true,
      // The sandbox writes as the kernel's own uid: the dir can stay private.
      getDriver: () => ({ sandboxUid: () => process.getuid!() }),
      getAvailableSlugs: () => ["fake"],
      async prepareRun(_slug: string, opts: { claudeAccountId?: string; transcriptDir?: string }) {
        const mode = opts.transcriptDir ? statSync(opts.transcriptDir).mode & 0o777 : null;
        prepared.push({ account: opts.claudeAccountId, transcriptDir: opts.transcriptDir, mode });
        sandboxProjects = opts.transcriptDir ?? null;
        return { executablePath: "/bin/sh", instanceId: `i${prepared.length}`, driver: "fake", startedAt: "" };
      },
      async cleanup() {},
    };
    const { service, agent, run } = setup();
    const executor = new ClaudeCodeExecutor();
    executor.setSandboxRegistry(registry as never);
    const sandboxed = { ...agent, variables: JSON.stringify({ __sandbox_driver__: "fake" }) };
    const result = await executor.execute({ agent: sandboxed, goal: "x", run, service });

    expect(result.status).toBe("completed");
    expect(tried()).toEqual(["A/" + OPUS, "B/" + OPUS]);
    expect(prepared.map((p) => p.account)).toEqual(["A", "B"]);
    expect(prepared[0]!.transcriptDir).toBeTruthy();
    expect(prepared[1]!.transcriptDir).toBe(prepared[0]!.transcriptDir);
    expect(prepared[0]!.mode).toBe(0o700);
    expect(calls[1]!.resume).toBe(SESSION);
    expect(calls[1]!.transcriptFound).toBe(true);
    expect(existsSync(prepared[0]!.transcriptDir!)).toBe(false);
  }, 30_000);

  it("does not resume a run that was cancelled", async () => {
    partialRoutes.add(`${A}|${OPUS}`);
    const { service, agent, run } = setup();
    const executor = new ClaudeCodeExecutor();
    // Cancelled after the limit notice arrived, before the hand-over.
    onQueryEnd = () => { executor.cancelRun(run.id); };
    const result = await executor.execute({ agent, goal: "x", run, service });
    expect(result.status).toBe("failed");
    expect(tried()).toEqual(["A/" + OPUS]);
  }, 30_000);
});

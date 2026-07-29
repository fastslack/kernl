import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluation } from "../assets/extensions/agents/agent-advanced/_module/workspace-evolver/evaluator.js";
import type { WorkspacePolicy } from "../assets/extensions/agents/agent-advanced/_module/workspace-evolver/types.js";

let workDir: string;

const policy = (cmd: string, timeout_s = 5): WorkspacePolicy => ({
  version: 1,
  mutable_globs: [],
  protected_globs: [],
  evaluation: { command: cmd, timeout_s },
});

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "evolver-eval-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("runEvaluation", () => {
  it("passes when command exits 0", async () => {
    const r = await runEvaluation(workDir, policy("true"));
    expect(r.passed).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.timed_out).toBe(false);
  });

  it("fails when command exits non-zero", async () => {
    const r = await runEvaluation(workDir, policy("false"));
    expect(r.passed).toBe(false);
    expect(r.exit_code).not.toBe(0);
  });

  it("captures stdout and stderr", async () => {
    const r = await runEvaluation(workDir, policy('echo hello && echo bye 1>&2'));
    expect(r.stdout).toContain("hello");
    expect(r.stderr).toContain("bye");
  });

  it("times out and reports timed_out=true", async () => {
    // `sleep 2` (not 5) so the eval resolves well under bun's 5s per-test
    // timeout even on a slow CI runner where the shell's child can keep the
    // stdout/stderr pipe open briefly after SIGKILL, delaying `close`. The 1s
    // eval timeout still fires first (timed_out=true). The explicit 15s
    // per-test timeout is belt-and-suspenders.
    const r = await runEvaluation(workDir, policy("sleep 2", 1));
    expect(r.timed_out).toBe(true);
    expect(r.passed).toBe(false);
  }, 15000);

  it("runs in policy.evaluation.cwd when set", async () => {
    const subDir = join(workDir, "sub");
    await Bun.write(join(subDir, ".keep"), "");
    const r = await runEvaluation(workDir, {
      version: 1,
      mutable_globs: [],
      protected_globs: [],
      evaluation: { command: "pwd", timeout_s: 5, cwd: "sub" },
    });
    expect(r.stdout).toContain("/sub");
  });

  it("non-existent command exits with non-zero", async () => {
    const r = await runEvaluation(workDir, policy("nonexistent_command_xyz_12345"));
    expect(r.passed).toBe(false);
    expect(r.exit_code).not.toBe(0);
  });

  it("respects script-style multi-line shell commands", async () => {
    const script = join(workDir, "multi.sh");
    await writeFile(script, "#!/bin/sh\necho line1\necho line2\nexit 0\n", "utf8");
    await chmod(script, 0o755);
    const r = await runEvaluation(workDir, policy("./multi.sh"));
    expect(r.passed).toBe(true);
    expect(r.stdout).toContain("line1");
    expect(r.stdout).toContain("line2");
  });
});

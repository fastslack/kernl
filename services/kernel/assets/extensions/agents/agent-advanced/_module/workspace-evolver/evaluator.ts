/**
 * Evaluator — runs the policy.evaluation.command inside a workspace and
 * returns a structured EvaluationResult. Exit code 0 = pass.
 *
 * Iteration 1 runs the eval as a host child process inside the workspace
 * directory. It does NOT go through the sandbox driver; the working
 * assumption is that the workspace already contains everything (deps,
 * scripts) the eval needs. Wrapping this through SandboxDriver is a follow-up
 * once the SEPL flow is exercised end-to-end.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { shellCommand } from "../../../../../../src/core/fs-paths.js";
import type { WorkspacePolicy, EvaluationResult } from "./types.js";

export async function runEvaluation(
  workspaceDir: string,
  policy: WorkspacePolicy,
): Promise<EvaluationResult> {
  const cwd = policy.evaluation.cwd
    ? resolve(workspaceDir, policy.evaluation.cwd)
    : workspaceDir;

  const start = Date.now();
  const result = await runShell(policy.evaluation.command, cwd, policy.evaluation.timeout_s * 1000);
  const duration_ms = Date.now() - start;

  return {
    passed: !result.timed_out && result.code === 0,
    exit_code: result.code,
    stdout: capture(result.stdout),
    stderr: capture(result.stderr),
    duration_ms,
    timed_out: result.timed_out,
  };
}

interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolveP) => {
    // `/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows — a hard-coded
    // /bin/sh failed with ENOENT there, so every cycle was rejected and the
    // reject path reverted the agent's edits.
    const shell = shellCommand(command);
    const child = spawn(shell.file, shell.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: shell.windowsVerbatimArguments,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({
        code: code ?? -1,
        stdout,
        stderr,
        timed_out: timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({
        code: -1,
        stdout,
        stderr: stderr + `\n${err instanceof Error ? err.message : String(err)}`,
        timed_out: timedOut,
      });
    });
  });
}

const MAX_OUTPUT_BYTES = 32_000;

/** Tail-truncate captured output. The tail is what matters most for triage —
 *  test failures and stack traces appear at the end. */
function capture(s: string): string {
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  return "[…truncated]\n" + s.slice(s.length - MAX_OUTPUT_BYTES);
}

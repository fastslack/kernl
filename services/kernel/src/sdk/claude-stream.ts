/**
 * Keeping a Claude Code run's message stream from hanging the run.
 *
 * On 19/11 two agent runs stayed `running` for hours although their CLI had
 * finished: the CLI wrote its `result`, the kernel never read it. The kernel
 * side of the child's stdout (a socketpair, under Bun) held ~30 KB unread
 * (`ss -x` Recv-Q 29863), the final `result` among them; the kernel had
 * stopped reading that socket minutes earlier, while other runs' sockets
 * kept flowing. Nothing in the SDK pauses it: Bun stops polling the fd.
 * With the data unread, stdout never reaches EOF, the SDK's iterator never
 * ends, stdin is never closed, and the CLI waits for input forever.
 *
 * Two pieces, used together by the claude_code executor:
 *
 *   - `spawnClaudeCodeWithFileStdio` runs the CLI with stdout and stderr
 *     redirected to (already unlinked) regular files that the kernel reads by
 *     offset. A regular file needs no readiness notification, so there is no
 *     poll registration to lose.
 *   - `settleClaudeStream` ends the iteration on its own when the run is
 *     cancelled, or when the stream does not end soon after the CLI's
 *     `result`, instead of waiting for an EOF that may never come.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, mkdirSync, openSync, read, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

export interface FileStdioOptions {
  /** Directory for the stdio files; they are unlinked as soon as the child has them. */
  dir?: string;
  /** Receives the CLI's stderr as text, as the SDK's own `stderr` option would. */
  onStderr?: (text: string) => void;
  /** How often the files are read while the CLI runs. */
  pollMs?: number;
}

const CHUNK = 64 * 1024;

function readAt(fd: number, buf: Buffer, position: number): Promise<number> {
  return new Promise((resolve, reject) => {
    read(fd, buf, 0, buf.length, position, (err, n) => (err ? reject(err) : resolve(n)));
  });
}

/** A regular file another process appends to, read from where we left off. */
class FileTail {
  private offset = 0;
  private readonly buf = Buffer.alloc(CHUNK);
  constructor(readonly fd: number) {}

  /** Everything written since the last call, in chunks. */
  async drain(onChunk: (chunk: Buffer) => void): Promise<void> {
    for (;;) {
      const n = await readAt(this.fd, this.buf, this.offset);
      if (n <= 0) return;
      this.offset += n;
      onChunk(Buffer.from(this.buf.subarray(0, n)));
    }
  }
}

function openStdioFile(dir: string, name: string): { fd: number; path: string } {
  const path = join(dir, name);
  const fd = openSync(path, "w+", 0o600);
  return { fd, path };
}

/**
 * A `spawnClaudeCodeProcess` for the SDK whose stdout cannot stall.
 *
 * stdin stays a pipe (the kernel only writes to it). stdout and stderr go to
 * two regular files the child inherits; the kernel reads them every `pollMs`.
 * `exit` is reported only once both files are drained and stdout has ended,
 * the order the SDK's own spawn keeps, so no message written before the exit
 * is lost.
 */
export function spawnClaudeCodeWithFileStdio(spawnOpts: SpawnOptions, opts: FileStdioOptions = {}): SpawnedProcess {
  const dir = opts.dir ?? join(tmpdir(), "kernl-claude-stdio");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const out = openStdioFile(dir, `${id}.out`);
  let err: { fd: number; path: string };
  try {
    err = openStdioFile(dir, `${id}.err`);
  } catch (e) {
    closeSync(out.fd);
    try { unlinkSync(out.path); } catch { /* best effort */ }
    throw e;
  }
  const leftovers = [out.path, err.path];
  const unlinkLeftovers = () => {
    for (const p of leftovers.splice(0)) {
      try { unlinkSync(p); } catch { leftovers.push(p); }
    }
  };

  const events = new EventEmitter();
  const stdout = new Readable({ read() { /* fed by the poller */ } });
  const outTail = new FileTail(out.fd);
  const errTail = new FileTail(err.fd);
  const decoder = new StringDecoder("utf8");
  const pollMs = Math.max(10, opts.pollMs ?? 100);

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let reported = false;
  let closed = false;
  let pumping: Promise<void> | null = null;

  const pumpOnce = async () => {
    await outTail.drain((chunk) => { stdout.push(chunk); });
    await errTail.drain((chunk) => {
      const text = decoder.write(chunk);
      if (text) opts.onStderr?.(text);
    });
  };
  const pump = (): Promise<void> => {
    if (!pumping) pumping = pumpOnce().finally(() => { pumping = null; });
    return pumping;
  };
  const closeFds = () => {
    if (closed) return;
    closed = true;
    for (const fd of [out.fd, err.fd]) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    unlinkLeftovers();
  };

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(spawnOpts.command, spawnOpts.args, {
      cwd: spawnOpts.cwd,
      env: spawnOpts.env as NodeJS.ProcessEnv,
      stdio: ["pipe", out.fd, err.fd],
      windowsHide: true,
    });
  } catch (e) {
    closeFds();
    throw e;
  }
  // The child holds its own descriptors now; the names are not needed (an
  // open file cannot be unlinked on Windows — retried at the end).
  unlinkLeftovers();

  // An `error` nobody listens to would throw out of the timer.
  const emitError = (e: unknown) => {
    if (events.listenerCount("error") > 0) events.emit("error", e instanceof Error ? e : new Error(String(e)));
  };
  const timer = setInterval(() => { void pump().catch(emitError); }, pollMs);
  timer.unref?.();

  const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
    if (reported) return;
    reported = true;
    clearInterval(timer);
    try {
      // A pass already under way may stop short of what the child wrote last.
      await pumping;
      await pump();
    } catch { /* whatever is unread is lost either way */ }
    const tail = decoder.end();
    if (tail) opts.onStderr?.(tail);
    closeFds();
    stdout.push(null);
    exited = { code, signal };
    events.emit("exit", code, signal);
  };

  child.once("exit", (code, signal) => { void finish(code, signal); });
  child.once("error", (e) => {
    emitError(e);
    // A child that never started emits no exit.
    if (child.pid === undefined) void finish(null, null);
  });

  const onAbort = () => { if (!exited) child.kill("SIGTERM"); };
  if (spawnOpts.signal?.aborted) onAbort();
  else spawnOpts.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    stdin: child.stdin!,
    stdout,
    get killed() { return child.killed; },
    get exitCode() { return exited ? exited.code : null; },
    get signalCode() { return exited ? exited.signal : null; },
    kill: (signal: NodeJS.Signals) => child.kill(signal),
    on: (event: "exit" | "error", listener: (...args: never[]) => void) => { events.on(event, listener as never); },
    once: (event: "exit" | "error", listener: (...args: never[]) => void) => { events.once(event, listener as never); },
    off: (event: "exit" | "error", listener: (...args: never[]) => void) => { events.off(event, listener as never); },
  } as SpawnedProcess;
}

/** Why `settleClaudeStream` stopped before the stream ended by itself. */
export type ClaudeStreamCut = "aborted" | "no_end_after_result";

export interface SettleOptions {
  /** The run's cancellation: iteration ends as soon as it aborts. */
  signal?: AbortSignal;
  /**
   * How long the stream may go on after the CLI's last `result` before it is
   * closed. The SDK closes the CLI's stdin on that result and the CLI exits
   * within seconds; a stream still open long after it is one that will not
   * end. 0 turns the cut off.
   */
  afterResultMs?: number;
  /** Told when the iteration was cut rather than ended by the stream. */
  onCut?: (why: ClaudeStreamCut) => void;
}

export const CLAUDE_STREAM_AFTER_RESULT_MS = 60_000;

type Closable<T> = AsyncIterable<T> & { close?: () => void };

/**
 * Iterates an SDK query like `for await`, but never waits on it forever.
 *
 * A pending `next()` of the SDK's iterator cannot be returned from: a
 * generator queues `return()` behind the step it is in, so breaking out of a
 * plain `for await` over a stalled query hangs as well. Here every step races
 * the abort signal and, once a `result` was seen, a deadline; whichever wins
 * closes the query (the SDK then kills the CLI) without awaiting the step.
 */
export async function* settleClaudeStream<T extends { type?: string }>(
  source: Closable<T>,
  opts: SettleOptions = {},
): AsyncGenerator<T, void, undefined> {
  const it = source[Symbol.asyncIterator]();
  const afterResultMs = opts.afterResultMs ?? CLAUDE_STREAM_AFTER_RESULT_MS;
  let deadline: number | null = null;
  let finished = false;
  const close = () => {
    try { source.close?.(); } catch { /* already closed */ }
  };

  type Step = { kind: "msg"; r: IteratorResult<T> } | { kind: "cut"; why: ClaudeStreamCut };
  const abortStep = (signal: AbortSignal) =>
    new Promise<Step>((resolve) => {
      if (signal.aborted) resolve({ kind: "cut", why: "aborted" });
      else signal.addEventListener("abort", () => resolve({ kind: "cut", why: "aborted" }), { once: true });
    });
  const aborted = opts.signal ? abortStep(opts.signal) : null;

  try {
    for (;;) {
      if (opts.signal?.aborted) {
        opts.onCut?.("aborted");
        close();
        return;
      }
      const pending = it.next();
      const racers: Array<Promise<Step>> = [pending.then((r) => ({ kind: "msg" as const, r }))];
      if (aborted) racers.push(aborted);
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (deadline !== null) {
        const wait = Math.max(0, deadline - Date.now());
        racers.push(new Promise<Step>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "cut", why: "no_end_after_result" }), wait);
        }));
      }
      let step: Step;
      try {
        step = await Promise.race(racers);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (step.kind === "cut") {
        // The abandoned step may still settle, or fail once the query closes.
        pending.catch(() => { /* nobody waits for it */ });
        opts.onCut?.(step.why);
        close();
        return;
      }
      if (step.r.done) {
        finished = true;
        return;
      }
      const msg = step.r.value;
      if (msg?.type === "result" && afterResultMs > 0) deadline = Date.now() + afterResultMs;
      yield msg;
    }
  } finally {
    // The consumer broke out early (or we were cut): let the query clean up,
    // but do not wait on a stalled one for more than a moment.
    if (!finished) {
      close();
      const ret = it.return?.();
      if (ret) {
        ret.catch(() => { /* closing anyway */ });
        let t: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([ret.then(() => undefined, () => undefined), new Promise<void>((r) => { t = setTimeout(r, 5_000); })]);
        if (t) clearTimeout(t);
      }
    }
  }
}

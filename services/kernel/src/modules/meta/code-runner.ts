/**
 * Sandboxed JS runner for `kernel_code_run`.
 *
 * The user/agent script runs inside a dedicated `node:worker_threads` Worker —
 * a separate JS realm, off the main thread. This is the C2 hardening: a `vm`
 * escape inside the worker can no longer reach the live kernel process (its
 * SQLite handles, services, secrets, or `process`) — the worker realm holds
 * none of them and has `process` neutralized. The script's only channel back
 * to the kernel is the RPC bridge below, which exposes exactly four host
 * capabilities: `tool()`, `log()`, `rank()`, `embed()`.
 *
 * Inside the worker the script still runs in a `vm.Context` with codegen
 * disabled: this is what enforces the wall-clock timeout (V8 interrupts a
 * synchronous loop via `runInContext({ timeout })` — verified reliable under
 * Bun, where `worker.terminate()` alone does NOT interrupt a synchronous
 * spin). The main-thread timer + `terminate()` is the secondary bound for
 * cooperative/async loops and cleanup.
 *
 * The host function `tool(name, args)` dispatches into the LIVE tool catalog on
 * the main thread. We snapshot the catalog at every invocation so runtime
 * registrations (extensions, plugins) are visible immediately.
 *
 * Residual (honest): the static regex below still gates the known `vm`-escape
 * syntax; the worker limits the blast radius if it were ever bypassed, but a
 * worker realm can still reach `import()` in theory. True OS-level isolation
 * (Docker/child_process) remains the stronger option — see
 * docs/security/audit-2026-06-09.md (C2).
 */

import { Worker } from "node:worker_threads";
import type { ToolDefinition, ToolResult } from "../../core/types.js";
import { RankingService } from "../../core/ranking/service.js";
import type { EmbeddingsClient } from "../../core/embeddings/client.js";

export interface SandboxDeps {
  ranking?: RankingService | null;
  embeddings?: EmbeddingsClient | null;
}

export interface ScriptInput {
  script: string;
  vars?: Record<string, unknown>;
  timeoutMs: number;
}

export interface ScriptOutput {
  result: unknown;
  logs: string[];
  durationMs: number;
}

// Reject the well-known `vm` escape vectors before spawning the worker. Node's
// `vm` is NOT a security sandbox on its own, so we statically reject the
// prototype-walking / process-reaching patterns that a classic escape needs.
// This is the first gate; the worker realm isolation is the second.
const ESCAPE_PATTERN =
  /\.\s*constructor\b|\bconstructor\s*[\[.]|__proto__|\bgetPrototypeOf\b|\bReflect\b|\bprocess\b|\bglobalThis\b/;

/**
 * Worker realm source. Runs the user script in a curated `vm` context and
 * bridges `tool`/`log`/`rank`/`embed` back to the main thread over messages.
 * Written as a string so it ships inline (no separate entry file to resolve in
 * the built/Docker image) and receives the user script via `workerData` rather
 * than string interpolation.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const _pp = parentPort;

// Harden the worker realm: a vm escape must not reach OS handles. parentPort
// is already captured, so nulling process does not break message passing.
globalThis.process = undefined;

let _rpcId = 0;
const _pending = new Map();
_pp.on("message", (m) => {
  if (m && m.type === "rpc-result") {
    const p = _pending.get(m.id);
    if (p) { _pending.delete(m.id); m.ok ? p.resolve(m.value) : p.reject(new Error(m.error)); }
  }
});
function _rpc(method, payload) {
  return new Promise((resolve, reject) => {
    const id = ++_rpcId;
    _pending.set(id, { resolve, reject });
    _pp.postMessage({ type: "rpc", id, method, payload });
  });
}

const tool = (name, args) => {
  if (typeof name !== "string") throw new TypeError("tool(name, args): name must be a string");
  return _rpc("tool", { name, args });
};
const log = (msg) => { _pp.postMessage({ type: "log", msg: String(msg) }); };
const embed = (texts) => {
  if (!Array.isArray(texts) || !texts.every((t) => typeof t === "string")) {
    throw new TypeError("embed(texts): texts must be string[]");
  }
  return _rpc("embed", { texts });
};
const rank = async (query, items, opts) => {
  if (typeof query !== "string") throw new TypeError("rank(query, items, opts): query must be a string");
  if (!Array.isArray(items)) throw new TypeError("rank(query, items, opts): items must be an array");
  // The key function stays in the worker; only cloneable {id,text} pairs cross
  // the boundary. We map ranked ids back to the original items here.
  const key = (opts && opts.key) || ((x) => {
    const o = (x && typeof x === "object" ? x : { value: x });
    const id = o.id !== undefined ? String(o.id) : JSON.stringify(o);
    const text = String(o.title != null ? o.title : o.name != null ? o.name : o.text != null ? o.text : o.body != null ? o.body : JSON.stringify(o));
    return { id, text };
  });
  const byId = new Map();
  const keyed = [];
  for (const x of items) { const k = key(x); byId.set(String(k.id), x); keyed.push({ id: String(k.id), text: String(k.text) }); }
  const orderedIds = await _rpc("rank", { query, keyed, k: opts && opts.k });
  return orderedIds.map((id) => byId.get(String(id)));
};

const sandbox = {
  tool, log, rank, embed,
  input: workerData.vars || {},
  // A small subset of globals the model expects. JSON / Math are pure; nothing
  // else (require, process, import, fetch, FS) is exposed.
  JSON, Math, Date, Object, Array, String, Number, Boolean, Promise,
  __result: undefined,
};
const ctx = vm.createContext(sandbox, { name: "kernel_code_run", codeGeneration: { strings: false, wasm: false } });

// Wrap in an async IIFE so top-level await and return both work.
const wrapped = "(async () => {\\n" + workerData.script + "\\n})().then(v => { __result = v; }, err => { throw err; });";
const started = Date.now();
try {
  const script = new vm.Script(wrapped, { filename: "kernel_code_run.js" });
  Promise.resolve(script.runInContext(ctx, { timeout: workerData.timeoutMs, breakOnSigint: true }))
    .then(async () => {
      // The IIFE assigns __result asynchronously; poll within the budget.
      const deadline = started + workerData.timeoutMs;
      while (sandbox.__result === undefined) {
        if (Date.now() >= deadline) { _pp.postMessage({ type: "error", error: "script timed out after " + workerData.timeoutMs + "ms" }); return; }
        await new Promise((r) => setTimeout(r, 5));
      }
      _pp.postMessage({ type: "done", result: sandbox.__result });
    })
    .catch((err) => _pp.postMessage({ type: "error", error: String((err && err.message) || err) }));
} catch (err) {
  const msg = String((err && err.message) || err);
  _pp.postMessage({ type: "error", error: /timed out/.test(msg) ? "script timed out after " + workerData.timeoutMs + "ms" : msg });
}
`;

export async function runScript(
  input: ScriptInput,
  getCatalog: () => ToolDefinition[],
  deps: SandboxDeps = {},
): Promise<ScriptOutput> {
  if (ESCAPE_PATTERN.test(input.script)) {
    throw new Error(
      "Script rejected: access to constructors, prototypes, process, or globalThis is not permitted in kernel_code_run.",
    );
  }

  const logs: string[] = [];
  const catalog = new Map(getCatalog().map((t) => [t.name, t]));
  const started = Date.now();

  // ── Main-thread RPC dispatch: the only capabilities the worker can reach ──
  const dispatch = async (method: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (method === "tool") {
      const name = payload.name as string;
      const def = catalog.get(name);
      if (!def) throw new Error(`tool not found: ${name}`);
      // Validate args against the tool's schema, exactly like the server's
      // CallTool path — surfaces script typos as structured zod errors.
      const parsed = def.inputSchema.parse(payload.args ?? {});
      const result: ToolResult = await def.handler(parsed);
      if (result.isError) {
        const text = result.content.map((c) => c.text).join("\n");
        throw new Error(`tool(${name}) returned isError: ${text}`);
      }
      if (result.structuredContent !== undefined) return result.structuredContent;
      return result.content.map((c) => c.text).join("\n");
    }
    if (method === "rank") {
      if (!deps.ranking) throw new Error("rank(): ranking not available in this context");
      const keyed = payload.keyed as Array<{ id: string; text: string }>;
      const out = await deps.ranking.rankAndPage({
        items: keyed,
        query: payload.query as string,
        key: (e) => ({ id: e.id, text: e.text }),
        k: (payload.k as number | undefined) ?? 20,
      });
      return out.ranked.map((e) => e.id);
    }
    if (method === "embed") {
      if (!deps.embeddings) throw new Error("embed(): embeddings not available in this context");
      return deps.embeddings.embed(payload.texts as string[], { inputType: "passage" });
    }
    throw new Error(`unknown rpc method: ${method}`);
  };

  return await new Promise<ScriptOutput>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { script: input.script, vars: input.vars ?? {}, timeoutMs: input.timeoutMs },
    });

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };

    // Secondary bound: the vm timeout is primary for synchronous loops; this
    // catches a cooperative/async loop or a wedged worker.
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`script timed out after ${input.timeoutMs}ms`)));
    }, input.timeoutMs + 1000);

    worker.on("message", (m: { type?: string; [k: string]: unknown }) => {
      if (settled || !m) return;
      if (m.type === "log") {
        logs.push(String(m.msg));
        return;
      }
      if (m.type === "rpc") {
        dispatch(m.method as string, (m.payload as Record<string, unknown>) ?? {})
          .then((value) => {
            if (!settled) worker.postMessage({ type: "rpc-result", id: m.id, ok: true, value });
          })
          .catch((e: unknown) => {
            if (!settled) {
              worker.postMessage({
                type: "rpc-result",
                id: m.id,
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        return;
      }
      if (m.type === "done") {
        finish(() => resolve({ result: m.result, logs, durationMs: Date.now() - started }));
        return;
      }
      if (m.type === "error") {
        finish(() => reject(new Error(String(m.error))));
        return;
      }
    });

    worker.on("error", (e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
    worker.on("exit", () => finish(() => reject(new Error("code runner worker exited before completing"))));
  });
}

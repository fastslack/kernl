import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  GetPromptRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListTasksRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./core/zod-to-json.js";
import type { ModuleRegistry } from "./core/module-registry.js";
import type { EventBus } from "./core/event-bus.js";
import { errorResult, stripInternalArgs } from "./core/helpers.js";
import { isAuthenticated } from "./core/auth.js";
import { log } from "./core/logger.js";
import { runWithContext, type KernelRequestContext } from "./core/request-context.js";
import type { SkillRegistry } from "./skills/registry.js";
import { TaskRegistry } from "./core/task-registry.js";
import { runWithServer } from "./core/elicit.js";
import {
  hashJson,
  signReceipt,
  type Identity,
  type Receipt,
} from "./core/attestation.js";
import {
  BUDGET_EXCEEDED_CODE,
  CostRouter,
  type Budget,
} from "./core/llm/cost-router.js";
import type { ToolMemoryService } from "./modules/tool-memory/service.js";
import { getRequestContext } from "./core/request-context.js";
import type { MeshServiceLike } from "./core/extension-seams.js";

/**
 * Side-table mapping each `Server` instance to its per-session `TaskRegistry`.
 * Lets the HTTP router clean up timers when a session closes without
 * changing `createMcpServer`'s public return type.
 */
const taskRegistries = new WeakMap<Server, TaskRegistry>();

/**
 * Apply forgiving coercion for the LLM mistakes that show up most often in
 * tool-call validation:
 *   - `Expected number, received string`  → parse numeric string with Number()
 *   - `Expected boolean, received string` → "true"/"false" → boolean
 *   - `Expected array, received string`   → JSON.parse when it yields an array
 *   - `Expected object, received string`  → JSON.parse when it yields an object
 *
 * Mutates a shallow clone of `args` along the issue's `path` and returns the
 * new object. Returns `null` when no path was coercible — caller should give
 * up and let the original ZodError surface so the LLM sees the error and can
 * self-correct on the next iteration.
 *
 * The array/object cases are not cosmetic. Some agent executors serialise
 * nested arguments before the call arrives here, so `at: [5, 8, 4]` reaches
 * validation as the string `"[5, 8, 4]"` and EVERY array or object parameter in
 * the kernel fails for those agents. That failure is unrecoverable from the
 * agent's side: it cannot observe how its arguments were serialised, the error
 * names the value it believes it sent, and every retry fails the same way — a
 * drawing agent hit exactly this and could create a scene but never put an
 * object into one.
 *
 * Enum / unknown-field / range issues are intentionally NOT coerced — those
 * indicate genuine LLM hallucinations (e.g. inventing a `"pending"` status),
 * and silently dropping them would mask broken behaviour. Same principle
 * bounds the JSON cases: the string must actually parse, and parse to the
 * shape that was asked for, or it is left alone for the error to surface.
 */
export function coerceCommonZodIssues(args: unknown, issues: Array<{
  code: string; path: (string | number)[]; expected?: string; received?: string;
}>): Record<string, unknown> | null {
  if (!args || typeof args !== "object") return null;
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(args));
  let mutated = false;

  for (const iss of issues) {
    if (iss.code !== "invalid_type") continue;
    if (!Array.isArray(iss.path) || iss.path.length === 0) continue;
    if (iss.received !== "string") continue;

    // Walk to the parent of the offending field.
    let parent: any = out;
    for (let i = 0; i < iss.path.length - 1; i++) {
      const key = iss.path[i];
      if (parent == null || typeof parent !== "object") { parent = null; break; }
      parent = parent[key as keyof typeof parent];
    }
    if (parent == null || typeof parent !== "object") continue;
    const leaf = iss.path[iss.path.length - 1];
    const raw = parent[leaf as keyof typeof parent];
    if (typeof raw !== "string") continue;

    if (iss.expected === "number") {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const n = Number(trimmed);
      if (Number.isFinite(n)) { parent[leaf as keyof typeof parent] = n; mutated = true; }
    } else if (iss.expected === "boolean") {
      const v = raw.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes")       { parent[leaf as keyof typeof parent] = true;  mutated = true; }
      else if (v === "false" || v === "0" || v === "no")  { parent[leaf as keyof typeof parent] = false; mutated = true; }
    } else if (iss.expected === "array" || iss.expected === "object") {
      // Only touch text that is trying to be JSON of the requested shape. The
      // opening-bracket check keeps `JSON.parse` away from prose and from bare
      // scalars like "7" or "null" — the latter being an object by `typeof`
      // and, unhandled, a null that fails further from its cause.
      const trimmed = raw.trim();
      const opener = iss.expected === "array" ? "[" : "{";
      if (!trimmed.startsWith(opener)) continue;
      try {
        const value = JSON.parse(trimmed);
        const fits = iss.expected === "array"
          ? Array.isArray(value)
          : value !== null && typeof value === "object" && !Array.isArray(value);
        if (fits) { parent[leaf as keyof typeof parent] = value; mutated = true; }
      } catch {
        // Not JSON after all — leave it for the original error to explain.
      }
    }
  }

  return mutated ? out : null;
}
export function getTaskRegistry(server: Server): TaskRegistry | undefined {
  return taskRegistries.get(server);
}

/**
 * Extract X-Caller-* headers a subprocess agent attaches to its MCP requests.
 * Unset / malformed headers fall back to the empty/zero defaults — meaning
 * the call is treated as top-level (e.g. dashboard, ad-hoc curl, mcp-bridge).
 */
function readCallerContext(req: IncomingMessage): KernelRequestContext {
  const get = (name: string): string => {
    const v = req.headers[name];
    if (Array.isArray(v)) return (v[0] ?? "").trim();
    return (v ?? "").toString().trim();
  };
  const depthRaw = get("x-caller-depth");
  const depth = depthRaw ? Math.max(0, Number.parseInt(depthRaw, 10) || 0) : 0;
  return {
    callerAgentId: get("x-caller-agent-id"),
    callerRunId: get("x-caller-run-id"),
    callerDepth: depth,
  };
}

function toCallToolResult(r: {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
  ui?: { mimeType: string; body: string };
}): CallToolResult {
  // The MCP spec doesn't yet have a `ui` content type — pushing one into
  // `content[]` makes the SDK's CallToolResultSchema reject the response.
  // We surface UI bodies via `_meta.ui` instead: the SDK doesn't validate
  // `_meta` (it's free-form by spec), capable clients (Claude Desktop /
  // web harnesses) read it, and CLI clients ignore it. Same forward-
  // compatibility intent, without the runtime rejection.
  const out: CallToolResult = { content: r.content, isError: r.isError };
  if (r.structuredContent !== undefined) {
    out.structuredContent = r.structuredContent as CallToolResult["structuredContent"];
  }
  if (r.ui) {
    const meta = (out._meta ?? {}) as Record<string, unknown>;
    meta.ui = { mimeType: r.ui.mimeType, body: r.ui.body };
    (out as { _meta?: unknown })._meta = meta;
  }
  return out;
}

export interface CreateMcpServerOptions {
  /**
   * Optional skill registry. When provided AND it has at least one enabled
   * skill, the server advertises the `prompts` capability and exposes one
   * prompt per skill ("skill::<id>") whose body is the skill description.
   * Mirrors what David's talk telegraphs as "skills over MCP".
   */
  skillRegistry?: SkillRegistry;
  /**
   * Enable the `tasks` capability. When true, the server allocates a
   * per-instance `TaskRegistry` and accepts task-augmented `tools/call`
   * requests (`params.task = { ttl, pollInterval }`) — the call returns
   * a `CreateTaskResult` immediately and the actual execution runs in the
   * background. Clients then poll `tasks/get` / `tasks/result` or cancel
   * via `tasks/cancel`.
   *
   * Default: true (cheap, no-op when no client uses it).
   */
  enableTasks?: boolean;
  /**
   * Optional Ed25519 attestation identity. When provided, every
   * `tools/call` response carries a signed `_meta.mtw.attestation`
   * receipt — see `core/attestation.ts`. Wire-compatible with the Rust
   * `mtw-attest` crate (a TS-signed receipt verifies in Rust and vice
   * versa).
   */
  identity?: Identity;
  /**
   * Optional cost router. When provided, `tools/call` enforces any
   * `_meta.budget` the client sent (rejecting with -32004 if the
   * estimated cost exceeds it) and records actual cost samples into
   * the rolling p50 history. See `core/cost-router.ts`.
   */
  costRouter?: CostRouter;
  /**
   * Optional tool-memory service. When provided, every successful
   * tool call is indexed by embedding (best-effort, never blocks the
   * response) and search results land in `_meta.mtw.memory` for
   * matches above the threshold.
   */
  toolMemory?: ToolMemoryService;
  /**
   * Optional mesh service. When provided, `tools/call` with a name
   * prefixed `peer:<short>:<remote_name>` is transparently proxied to
   * the trusted peer.
   */
  mesh?: MeshServiceLike;
}

export function createMcpServer(
  registry: ModuleRegistry,
  events?: EventBus,
  opts: CreateMcpServerOptions = {},
): Server {
  // Resource providers are gathered up front. Empty array → declare no
  // `resources` capability so legacy clients see the same surface as before.
  const resourceProviders = registry.getAllResourceProviders();
  const providersByScheme = new Map(resourceProviders.map((p) => [p.scheme, p]));

  const skillRegistry = opts.skillRegistry;
  const enabledSkills = skillRegistry?.getEnabledSkills() ?? [];
  const enableTasks = opts.enableTasks !== false;
  const taskRegistry = enableTasks ? new TaskRegistry() : null;

  const capabilities: {
    tools: Record<string, unknown>;
    resources?: Record<string, never>;
    prompts?: Record<string, never>;
    tasks?: {
      list: Record<string, never>;
      cancel: Record<string, never>;
      requests: { tools: { call: Record<string, never> } };
    };
  } = {
    tools: {},
  };
  if (resourceProviders.length > 0) capabilities.resources = {};
  if (enabledSkills.length > 0) capabilities.prompts = {};
  if (taskRegistry) {
    // Spec-shape `ServerTasksCapability`: announces `list`, `cancel`, and
    // task-augmented `tools/call` support. Clients that don't speak tasks
    // ignore the field; clients that do gain async background execution.
    capabilities.tasks = {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    };
  }

  const server = new Server(
    { name: "kernl", version: "0.1.0" },
    { capabilities },
  );

  if (taskRegistry) taskRegistries.set(server, taskRegistry);

  // ── Build tool cache once per server instance ──────────────
  // zodToJsonSchema is expensive; cache the output. Map gives O(1) CallTool lookup.
  const allTools = registry.getAllTools();
  const toolMap = new Map(allTools.map((t) => [t.name, t]));
  const listToolsResponse = {
    tools: allTools.map((t) => {
      const entry: {
        name: string;
        description: string;
        inputSchema: ReturnType<typeof zodToJsonSchema>;
        outputSchema?: ReturnType<typeof zodToJsonSchema>;
      } = {
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
      };
      if (t.outputSchema) {
        // Structured output: clients on protocol ≥ 2025-03-26 use this to
        // type-check results. Older clients ignore unknown fields per spec.
        entry.outputSchema = zodToJsonSchema(t.outputSchema);
      }
      return entry;
    }),
  };

  // ── ListTools ─────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => listToolsResponse);

  // ── CallTool ──────────────────────────────────────────────
  // The actual tool execution is split out so the task-augmented path
  // (below) can spawn it in the background and reply with a CreateTaskResult.
  // Every dispatch is wrapped in `runWithServer` so handlers that need
  // server-initiated elicitation can reach this connection without
  // changing their signature — see `core/elicit.ts`.
  const identity = opts.identity;
  const costRouter = opts.costRouter;
  const toolMemory = opts.toolMemory;
  const mesh = opts.mesh;

  /** Canonical projection of a tool result, used as the receipt's
   *  output_hash input. Mirrors the Rust `output_canonical_value`
   *  in `crates/mtw-mcp/src/protocol.rs` field-for-field — must stay
   *  in sync or cross-language verification breaks. */
  const canonicalOutput = (
    result: { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: unknown; ui?: { mimeType: string; body: string } },
    isError: boolean,
  ): Record<string, unknown> => {
    const text = result.content.map((c) => c.text ?? "").join("");
    const obj: Record<string, unknown> = { text, isError };
    if (result.structuredContent !== undefined) obj.structuredContent = result.structuredContent;
    if (result.ui) obj.uiMimeType = result.ui.mimeType;
    return obj;
  };

  const attachReceipt = (
    name: string,
    args: unknown,
    result: CallToolResult,
    sideEffects: string[],
  ): CallToolResult => {
    if (!identity) return result;
    const receipt: Receipt = signReceipt({
      identity,
      tool: name,
      inputHash: hashJson(args ?? {}),
      outputHash: hashJson(canonicalOutput(result as unknown as Parameters<typeof canonicalOutput>[0], result.isError === true)),
      sideEffects,
    });
    const meta: Record<string, unknown> = { ...(result._meta ?? {}), "mtw.attestation": receipt };
    return { ...result, _meta: meta } as CallToolResult;
  };

  /**
   * Stitch a budget-related _meta block onto a CallToolResult. Used
   * both pre-flight (refused budget) and post-flight (estimated vs.
   * actual cost telemetry).
   */
  const attachCostMeta = (
    result: CallToolResult,
    cost: { estimated?: import("./core/llm/cost-router.js").CostEstimate; actual?: import("./core/llm/cost-router.js").ActualCost },
  ): CallToolResult => {
    if (!cost.estimated && !cost.actual) return result;
    const meta: Record<string, unknown> = { ...(result._meta ?? {}) };
    const block: Record<string, unknown> = {};
    if (cost.estimated) block.estimated = cost.estimated;
    if (cost.actual) block.actual = cost.actual;
    meta["mtw.cost"] = block;
    return { ...result, _meta: meta } as CallToolResult;
  };

  const executeToolCall = async (
    name: string,
    args: unknown,
    budget?: Budget,
  ): Promise<CallToolResult> => {
    const tool = toolMap.get(name);
    if (!tool) {
      const errResult = toCallToolResult(errorResult(`Unknown tool: ${name}`));
      return attachReceipt(name, args, errResult, []);
    }

    // Pre-flight budget check. Refusing here costs nothing; refusing
    // post-execution would already have spent the dollars.
    let estimate: import("./core/llm/cost-router.js").CostEstimate | undefined;
    if (costRouter) {
      const check = costRouter.checkBudget(tool, budget);
      estimate = check.estimate;
      if (!check.ok) {
        const errResult = toCallToolResult(
          errorResult(`Budget exceeded: ${check.reason}`),
        );
        const withCost = attachCostMeta(errResult, { estimated: check.estimate });
        return attachReceipt(name, args, withCost, []);
      }
    }

    return runWithServer(server, async () => {
      const started = Date.now();
      const requestCtx = getRequestContext();
      const correlationId = `${started}_${name}`;
      events?.emit("tool.call.start", { tool: name, from: "self", to: "", correlation_id: correlationId }).catch(() => {});

      // Memory: surface similar past calls *before* running, so that
      // when the model retries something it gets the prior outcome
      // alongside the new one. Best-effort — embeddings down ⇒ no hint.
      let similar: Array<{ tool: string; similarity: number; succeeded: boolean }> | undefined;
      if (toolMemory) {
        try {
          const matches = await toolMemory.findSimilar({
            tool: name,
            input: args,
            ownerAgentId: requestCtx.callerAgentId,
            limit: 3,
          });
          if (matches.length > 0) {
            similar = matches.map((m) => ({
              tool: m.record.tool,
              similarity: Number(m.similarity.toFixed(3)),
              succeeded: m.record.succeeded === 1,
            }));
          }
        } catch { /* memory is opportunistic */ }
      }

      try {
        // Parse with one self-healing retry: when the LLM sends a numeric
        // string where a number is expected (or "true"/"false" where a bool
        // is expected — common in qwen / grok-fast outputs), coerce and try
        // again. Genuine schema violations (invented enum values, missing
        // required fields, etc.) still throw — the LLM needs to see them.
        let parsed: unknown;
        // Double-underscore keys (`__caller_agent_id`, `__caller_run_id`, ...)
        // are a kernel-internal channel that AgentExecutor injects when it
        // calls a tool's handler directly, bypassing this dispatch entirely.
        // Some schemas now declare those fields (optional) so they survive
        // parsing on that in-process path; without stripping them here, an
        // external `tools/call` client could set `__caller_agent_id` itself
        // and impersonate any agent to the caller-aware tools. Reserved for
        // kernel-internal injection — must never be accepted from outside.
        args = stripInternalArgs(args);
        const safe = tool.inputSchema.safeParse(args);
        if (safe.success) {
          parsed = safe.data;
        } else {
          const coerced = coerceCommonZodIssues(args, safe.error.issues as Array<{
            code: string; path: (string | number)[]; expected?: string; received?: string;
          }>);
          if (coerced) {
            log.debug(`Tool ${name}: auto-coerced string→number/bool args before re-parse`);
            parsed = tool.inputSchema.parse(coerced);
          } else {
            throw safe.error;
          }
        }
        const handlerResult = await tool.handler(parsed);
        const elapsed = Date.now() - started;
        if (events && !handlerResult.isError) {
          const module = name.replace("kernel_", "").split("_")[0];
          events.emit("data.changed", { module, tool: name }).catch(() => {});
        }
        const sideEffects = handlerResult.isError ? [] : (tool.sideEffects ?? []);

        if (costRouter && !handlerResult.isError) {
          costRouter.record(name, {
            latency_ms: elapsed,
            tokens: tool.cost?.tokens_p50,
            usd: tool.cost?.usd_p50,
          });
        }

        let wireResult = toCallToolResult(handlerResult);
        if (costRouter) {
          wireResult = attachCostMeta(wireResult, {
            estimated: estimate,
            actual: { latency_ms: elapsed, tokens: tool.cost?.tokens_p50, usd: tool.cost?.usd_p50 },
          });
        }
        if (similar) {
          const meta: Record<string, unknown> = { ...(wireResult._meta ?? {}) };
          meta["mtw.memory"] = { similar_past_calls: similar };
          wireResult = { ...wireResult, _meta: meta } as CallToolResult;
        }

        // Index *after* responding logically (we still await it because
        // the test suite needs deterministic ordering, but it's a fast
        // op and embeddings is sync after the model load).
        if (toolMemory && !handlerResult.isError) {
          toolMemory
            .record({
              tool: name,
              input: args,
              output: { content: handlerResult.content, structuredContent: handlerResult.structuredContent },
              succeeded: true,
              ownerAgentId: requestCtx.callerAgentId,
            })
            .catch(() => { /* logged inside service */ });
        }

        const final = attachReceipt(name, args, wireResult, sideEffects);
        events?.emit("tool.call.end", { tool: name, from: "self", to: "", isError: handlerResult.isError === true, correlation_id: correlationId }).catch(() => {});
        if (identity && !handlerResult.isError) {
          events?.emit("attest.receipt", { tool: name, signer: identity.serverId() }).catch(() => {});
        }
        return final;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Tool ${name} failed`, err);
        const errResult = toCallToolResult(errorResult(message));
        const withCost = estimate ? attachCostMeta(errResult, { estimated: estimate }) : errResult;
        events?.emit("tool.call.end", { tool: name, from: "self", to: "", isError: true, correlation_id: correlationId }).catch(() => {});
        return attachReceipt(name, args, withCost, []);
      }
    });
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // _meta.budget arrives alongside the tool call; pull it out before
    // dispatching so the cost router can do a pre-flight check.
    const meta = (req.params as { _meta?: { budget?: Budget } })._meta;
    const budget = meta?.budget;

    // Mesh proxy: `peer:<short>:<remote_name>` is forwarded verbatim to
    // the trusted peer. We don't attest the proxy hop locally — the
    // peer's receipt rides through under its own server_id. (#1 phase 2
    // will encadenar both signatures into a chained receipt.)
    if (mesh) {
      const resolved = mesh.resolveLocal(req.params.name);
      if (resolved) {
        const cid = `${Date.now()}_${req.params.name}`;
        events?.emit("tool.call.start", { tool: resolved.remoteName, from: "self", to: resolved.peer.peer_id, correlation_id: cid }).catch(() => {});
        try {
          const remote = await mesh.callPeerTool({
            peerId: resolved.peer.peer_id,
            toolName: resolved.remoteName,
            arguments: req.params.arguments,
          });
          events?.emit("tool.call.end", { tool: resolved.remoteName, from: "self", to: resolved.peer.peer_id, isError: false, correlation_id: cid }).catch(() => {});
          return remote as CallToolResult;
        } catch (e) {
          events?.emit("tool.call.end", { tool: resolved.remoteName, from: "self", to: resolved.peer.peer_id, isError: true, correlation_id: cid }).catch(() => {});
          return toCallToolResult(errorResult(`mesh proxy failed: ${(e as Error).message}`));
        }
      }
    }

    // Task augmentation: when the client passed `params.task`, return a
    // CreateTaskResult immediately and execute in the background. The
    // client polls `tasks/result` for the actual CallToolResult payload.
    const taskMeta = (req.params as { task?: { ttl?: number | null; pollInterval?: number } }).task;
    if (taskMeta && taskRegistry) {
      const wire = taskRegistry.create(
        { ttl: taskMeta.ttl, pollInterval: taskMeta.pollInterval },
        async (signal) => {
          if (signal.aborted) throw new Error("cancelled");
          return executeToolCall(req.params.name, req.params.arguments, budget);
        },
      );
      return { task: wire } as unknown as CallToolResult;
    }
    return executeToolCall(req.params.name, req.params.arguments, budget);
  });

  // ── Tasks (list / get / result / cancel) ──────────────────
  if (taskRegistry) {
    server.setRequestHandler(ListTasksRequestSchema, async (req) => {
      const cursor = req.params?.cursor;
      const { tasks: list, nextCursor } = taskRegistry.list(cursor);
      return { tasks: list, ...(nextCursor ? { nextCursor } : {}) };
    });

    server.setRequestHandler(GetTaskRequestSchema, async (req) => {
      const wire = taskRegistry.get(req.params.taskId);
      if (!wire) throw new Error(`Task not found: ${req.params.taskId}`);
      // GetTaskResultSchema = ResultSchema.merge(TaskSchema), so spread the
      // wire fields at the top level.
      return wire;
    });

    server.setRequestHandler(GetTaskPayloadRequestSchema, async (req) => {
      const r = taskRegistry.result(req.params.taskId);
      if (!r.found) throw new Error(`Task not found: ${req.params.taskId}`);
      if (!r.ready) {
        // The spec lets us throw to signal "not ready yet"; clients then
        // back off and re-poll. -32002 is unofficial but well-known for
        // "not yet available".
        throw new Error(`Task not ready (status: ${r.status})`);
      }
      // Loose schema — return whatever the original request would have.
      return r.payload as Record<string, unknown>;
    });

    server.setRequestHandler(CancelTaskRequestSchema, async (req) => {
      const wire = taskRegistry.cancel(req.params.taskId);
      if (!wire) throw new Error(`Task not found: ${req.params.taskId}`);
      return wire;
    });
  }

  // ── Resources ─────────────────────────────────────────────
  // Only registered when at least one provider exists. Each `resources/list`
  // request fans out to every provider; failures from one provider are
  // logged but never poison the whole listing.
  if (resourceProviders.length > 0) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }> = [];
      for (const p of resourceProviders) {
        try {
          const items = await p.list();
          for (const it of items) resources.push(it);
        } catch (err) {
          log.warn(`ResourceProvider "${p.scheme}" list() failed`, err);
        }
      }
      return { resources };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const uri = req.params.uri;
      let scheme = "";
      try {
        // URL parsing chokes on unusual schemes (e.g. `kernel-analysis://...`),
        // but the part before the first `:` is what we need; do that manually
        // and only fall back to `URL` for sanity-checking when present.
        const colon = uri.indexOf(":");
        if (colon > 0) scheme = uri.slice(0, colon);
      } catch {
        scheme = "";
      }
      const provider = providersByScheme.get(scheme);
      if (!provider) {
        throw new Error(`No resource provider for scheme "${scheme}" (uri: ${uri})`);
      }
      const content = await provider.read(uri);
      if (!content) {
        throw new Error(`Resource not found: ${uri}`);
      }
      return {
        contents: [{
          uri: content.uri,
          mimeType: content.mimeType,
          ...(content.text !== undefined ? { text: content.text } : {}),
          ...(content.blob !== undefined ? { blob: content.blob } : {}),
        }],
      };
    });
  }

  // ── Prompts (skills over MCP) ────────────────────────────
  // Each enabled skill becomes one MCP prompt named `skill::<id>`. Pulling
  // the prompt loads a system-message-shaped briefing that tells the model
  // what the skill is, how to invoke it, and what permissions it has.
  if (skillRegistry && enabledSkills.length > 0) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const skills = skillRegistry.getEnabledSkills();
      return {
        prompts: skills.map((s) => ({
          name: `skill::${s.manifest.id}`,
          description: s.manifest.description,
          arguments: [],
        })),
      };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const name = req.params.name;
      const id = name.startsWith("skill::") ? name.slice("skill::".length) : null;
      if (!id) throw new Error(`Unknown prompt: ${name}`);
      const state = skillRegistry.getSkill(id);
      if (!state) throw new Error(`Skill not found: ${id}`);

      // SkillManifest extends SkillMetadata — fields are flat.
      const meta = state.manifest;
      const tags = meta.tags ?? [];
      const text =
        `You have access to the **${meta.name}** skill ` +
        `(\`${meta.id}\` v${meta.version} by ${meta.author}).\n\n` +
        `${meta.description}\n\n` +
        (tags.length ? `Tags: ${tags.join(", ")}\n` : "");

      return {
        description: meta.description,
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    });
  }

  return server;
}

export async function startStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server running on stdio");
}

// ── Streamable HTTP MCP Router ──────────────────────────────

interface McpSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

/** Hard cap on concurrent MCP HTTP sessions (memory-exhaustion DoS guard). */
const MAX_MCP_SESSIONS = 256;
/** Sessions with no traffic for this long are reaped on the next connection. */
const MCP_SESSION_IDLE_MS = 10 * 60 * 1000;

/**
 * Manages multiple MCP sessions over Streamable HTTP.
 * Each client gets its own Server + Transport pair;
 * the ModuleRegistry is shared (read-only after init).
 */
export class McpHttpRouter {
  private sessions = new Map<string, McpSession>();

  constructor(
    private registry: ModuleRegistry,
    private events?: EventBus,
    private opts: CreateMcpServerOptions = {},
    /**
     * Bearer token required to reach the public HTTP `/mcp` endpoint.
     * Empty string disables auth (dev mode), matching the `/api/*` gate.
     * Subprocess agents use the Unix-domain socket, which is access-controlled
     * by file permissions and never passes through this router.
     */
    private authToken: string = "",
  ) {}

  /** Entry point — mount with httpServer.all("/mcp", ...) */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ── Authentication gate ──
    // The public HTTP `/mcp` endpoint exposes every kernel tool. Require the
    // Bearer token before touching session state, mirroring the `/api/*` gate
    // in http-server.ts. When no token is configured, auth is disabled.
    const authed = this.authToken !== "" && isAuthenticated(req, this.authToken);
    if (this.authToken && !authed) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" } }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Lift caller-context headers off the request and propagate via
    // AsyncLocalStorage so MCP tool handlers (kernel_agents_run / _invoke)
    // can read them without changing every handler signature.
    //
    // SECURITY: trust the X-Caller-* headers ONLY on an authenticated request.
    // They grant agent lineage and recursion depth — an unauthenticated or
    // external TCP client could forge X-Caller-Agent-Id to bypass the
    // self-invocation guard, or forge X-Caller-Depth to reset the recursion
    // cap (→ runaway agent recursion / lineage forgery). Legitimate subprocess
    // agents never reach this router: they pass caller context via the
    // Unix-socket handshake (core/mcp-unix-socket.ts). So an untrusted request
    // gets the empty/zero top-level context.
    const ctx = authed
      ? readCallerContext(req)
      : { callerAgentId: "", callerRunId: "", callerDepth: 0 };

    // Existing session — delegate to its transport
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found" } }));
        return;
      }
      session.lastSeen = Date.now();
      await runWithContext(ctx, () => session.transport.handleRequest(req, res));
      return;
    }

    // No session ID — only POST can initialize a new session
    if (req.method !== "POST") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Missing mcp-session-id header" } }));
      return;
    }

    // DoS guard: reap idle sessions, then refuse if the map is still full.
    // Abandoned sessions (POST without `initialize`, never closed) would
    // otherwise grow `this.sessions` unbounded — each holds a Server +
    // TaskRegistry + tool catalog.
    this.reapIdleSessions();
    if (this.sessions.size >= MAX_MCP_SESSIONS) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32002, message: "Server busy: too many MCP sessions" } }));
      return;
    }

    // Create new session
    const session = await this.createSession();
    await runWithContext(ctx, () => session.transport.handleRequest(req, res));
  }

  private async createSession(): Promise<McpSession> {
    // session is captured by the onsessioninitialized closure below.
    // It's assigned synchronously before handleRequest is called.
    let session: McpSession;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        // Called synchronously during handleRequest when initialize succeeds.
        // At this point `session` is already assigned.
        this.sessions.set(id, session);
        log.info(`MCP HTTP session initialized: ${id}`);
      },
      onsessionclosed: (id) => {
        const closing = this.sessions.get(id);
        if (closing) getTaskRegistry(closing.server)?.shutdown();
        this.sessions.delete(id);
        log.info(`MCP HTTP session closed: ${id}`);
      },
    });

    const server = createMcpServer(this.registry, this.events, this.opts);
    await server.connect(transport);

    session = { server, transport, lastSeen: Date.now() };
    return session;
  }

  /** Close and drop sessions with no traffic for MCP_SESSION_IDLE_MS. */
  private reapIdleSessions(): void {
    const cutoff = Date.now() - MCP_SESSION_IDLE_MS;
    for (const [id, session] of this.sessions) {
      if (session.lastSeen < cutoff) {
        getTaskRegistry(session.server)?.shutdown();
        session.transport.close().catch(() => {});
        session.server.close().catch(() => {});
        this.sessions.delete(id);
        log.info(`MCP HTTP session reaped (idle): ${id}`);
      }
    }
  }

  /** Gracefully close all sessions. */
  async shutdown(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session) {
        getTaskRegistry(session.server)?.shutdown();
        await session.transport.close();
        await session.server.close();
      }
    }
    this.sessions.clear();
    log.info(`MCP HTTP router shut down (${ids.length} sessions closed)`);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}

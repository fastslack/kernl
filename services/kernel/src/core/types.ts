import type { z } from "zod";
import type { SqliteDb } from "./db/sqlite.js";
import type { Neo4jClient } from "./db/neo4j.js";
import type { GraphDriver } from "./db-drivers/graph-driver.js";
import type { EventBus } from "./event-bus.js";
import type { KernelConfig } from "./config.js";
import type { SystemRegistry } from "./system-registry.js";
import type { Notifier } from "./notify/notifier.js";
import type { KernelHttpServer } from "./http-server.js";
import type { LicenseService } from "./license/index.js";

/**
 * Shape returned by every tool handler — matches MCP CallToolResult.
 *
 * `content` stays text-only for back-compat. The two optional fields below
 * are the surface the protocol team has been pushing in the talk:
 *   * `structuredContent` — typed JSON payload paired with `outputSchema`.
 *     Lets clients on protocol ≥ 2025-03-26 parse results without regex.
 *   * `_meta.ui` — opt-in MCP-application content. A web client (Claude
 *     Desktop, ChatGPT) renders it; CLI clients ignore it.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
  /** UI content for "MCP applications". Rendered by clients that opt in. */
  ui?: { mimeType: string; body: string };
}

/**
 * Single tool exposed to the MCP client.
 *
 * `outputSchema` is optional. Tools that set it get a `structuredContent`
 * field appended to their response and become first-class for programmatic
 * tool calling (the model knows the shape of the return value without
 * having to parse free text). `tags` are consumed by the meta module's
 * `kernel_tool_search` for progressive discovery.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType<unknown>;
  outputSchema?: z.ZodType<unknown>;
  tags?: string[];
  /**
   * Side-effects manifest declared by the tool. Convention:
   * `"<resource>.<verb>:<count>"` (e.g. `"email.sent:3"`,
   * `"calendar.event.created:1"`). Empty / absent for read-only tools.
   * Surfaces in the signed attestation receipt — see `core/attestation.ts`.
   */
  sideEffects?: string[];
  /**
   * Static cost metadata for this tool. Optional; when present, the MCP
   * server enforces it pre-flight against any `_meta.budget` the client
   * sent, and updates rolling p50 stats post-flight (see
   * `core/cost-router.ts`). Tools that omit this default to "unknown
   * cost" — clients with strict budgets can decide to refuse them.
   */
  cost?: ToolCost;
  /**
   * Optional inverse pointer. When a plan executor needs to roll back
   * (a later node failed, this node already ran), it looks up `inverse`
   * and invokes that tool with args derived from this call's
   * (input, output). Without an `inverse`, a non-reversible tool ran and
   * cannot be undone — the executor flags `rollback_attempted` but
   * leaves the rest of the plan in a partial-completion state.
   *
   * The inverse tool MUST itself be declared in the catalog at execute
   * time. We don't enforce that statically (the catalog is built late)
   * but the rollback path emits a clear failure if the lookup misses.
   */
  inverse?: ToolInverse;
  handler: (args: unknown) => Promise<ToolResult>;
}

export interface ToolInverse {
  /** Name of another registered tool that undoes this one. */
  tool: string;
  /**
   * Source for the inverse's input. Default `"output"`:
   *   * `"input"`  → pass this call's original `args` (idempotent
   *                 inverses, e.g. delete-by-id when the original
   *                 received the id directly).
   *   * `"output"` → pass this call's structuredContent (typical:
   *                 create returns `{id}`, delete consumes `{id}`).
   */
  argsFrom?: "input" | "output";
}

/**
 * Cost shape for a single tool. p50 numbers are the *expected* cost of
 * one invocation; the server's instrumentation refines these over time
 * via a rolling-window in `tool_cost_history`.
 */
export interface ToolCost {
  /** Median tokens consumed (input + output). 0 when not LLM-backed. */
  tokens_p50?: number;
  /** Median dollar cost per call. */
  usd_p50?: number;
  /** Median wall-clock latency in milliseconds. */
  latency_p50_ms?: number;
  /** Whether the tool can be undone after running. Drives plan-level
   *  approval gates (see #5) — non-reversible tools require explicit
   *  user confirmation. Default: false (assume destructive). */
  reversible?: boolean;
  /** Whether identical inputs produce identical outputs. Memory layer
   *  uses this to decide whether to short-circuit repeats. */
  cacheable?: boolean;
}

/**
 * One MCP resource a module exposes — read-only piece of context the model
 * (or a human) can list and fetch on demand. Cheaper than a tool when the
 * payload is purely informational (workspace analyses, skill files, agent
 * directory snapshots) — the model doesn't need an inference round-trip to
 * read it; the harness can pull it directly.
 */
export interface ResourceListing {
  /** Fully-qualified URI. The scheme MUST match the provider's `scheme`. */
  uri: string;
  /** Human-readable label shown in resource pickers. */
  name: string;
  /** Optional one-line description. */
  description?: string;
  /** MIME type of the body returned by `read()`. Defaults to text/markdown. */
  mimeType?: string;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  /** Text body. Set this OR `blob` (base64) — never both. */
  text?: string;
  blob?: string;
}

/**
 * A bundle of resources sharing a URI scheme. Modules return one or more of
 * these from `getResources()`. The MCP server dispatches `resources/read` by
 * URL scheme; `list()` is called for `resources/list` and the results are
 * concatenated across providers.
 */
export interface ResourceProvider {
  /** URI scheme this provider owns, e.g. `kernel-analysis`, `kernel-skill`. */
  scheme: string;
  /** Enumerate every readable resource. Should be cheap — the catalog is
   *  fetched on every `resources/list` call. */
  list(): Promise<ResourceListing[]>;
  /** Resolve a URI to its body. Return null when the URI is unknown — the
   *  server converts that into a structured "not found" error. */
  read(uri: string): Promise<ResourceContent | null>;
}

/** Context injected into every module at init time */
export interface ModuleContext {
  sqlite: SqliteDb;
  /**
   * Legacy direct Neo4j connector. Stays for now — the ~40 modules that use
   * it keep working unchanged. Migrate to `graph` (below) at your own pace;
   * deletion happens once every consumer is ported.
   * @deprecated Use `graph` (GraphDriver) instead; guard with `graph?.capabilities.cypher`.
   */
  neo4j: Neo4jClient;
  /**
   * Active graph driver from the DbDriverRegistry, or null when no driver
   * is active or the active driver isn't ready. This is a LIVE getter — it
   * reflects the current state of `/extensions` toggles, so consumers that
   * read it per-call automatically pick up backend switches without a
   * restart. Capture once at init time only if you want a frozen snapshot.
   *
   * Canonical guard for graph operations: `ctx.graph?.capabilities.cypher` (replaces legacy `neo4j.available`).
   *
   * Migration cheat-sheet:
   *   ctx.neo4j.available           → ctx.graph?.capabilities.cypher
   *   ctx.neo4j.run(cypher, params) → ctx.graph?.run(cypher, params)
   *   ctx.neo4j.withSession(fn)     → ctx.graph?.withSession(fn)
   * GDS-using code should additionally gate on `ctx.graph?.capabilities.gds`.
   */
  graph: GraphDriver | null;
  events: EventBus;
  config: KernelConfig;
  systemRegistry: SystemRegistry;
  notifier: Notifier;
  /**
   * Pro license gate. Free modules ignore this entirely. Pro modules
   * call `ctx.license.has('pro:<module>')` inside `initialize()` to decide
   * whether to register real tools or stub tools that direct users to
   * lifekernl.com/pricing. Authoring docs for pro modules are maintained
   * outside this repository.
   */
  license: LicenseService;
  /**
   * Resolve sibling modules (typically extensions) by their registered name.
   * For extensions, the name is `ext:<slug>`. Returns null if the module is
   * not yet registered or not active. Use this in `initialize()` to wire
   * cross-extension dependencies (e.g. `trading` resolving `api-registry`).
   */
  getModule?: (name: string) => KernelModule | null;
}

/**
 * A self-describing scheduled agent driver contributed by a module/extension.
 *
 * This is the "CMS plugin" channel for builtin (no-LLM) agents: each module
 * ships its own drivers instead of the kernel hardcoding wrappers per
 * extension. The kernel collects them post-init (see
 * `ModuleRegistry.collectAgentDrivers()`), merges `run` closures into the
 * scheduler/executor builtin-handler map keyed by `handler`, and upserts an
 * `agents` row (+ cron schedule) for every def that declares a `cron` via the
 * generic seeder (`src/modules/agents/seed-driver-agents.ts`).
 *
 * `handler` must stay stable — existing DB rows resolve by `builtin_handler`.
 * `run` closes over the owning module's own services; it must return a short
 * result string for the agent run log, or an `AgentDriverFailure` when the
 * work did not succeed.
 */

/**
 * Explicit failure signal from a driver/builtin handler.
 *
 * A driver that returns a plain string is always recorded as a SUCCESSFUL run.
 * When the work failed (dead upstream, bad credentials, unparseable feed) the
 * driver must say so — either by throwing or by returning this shape — so the
 * run is stored as `failed`, the consecutive-failure counter advances, and the
 * agent gets auto-paused instead of burning its cron slot forever.
 */
export interface AgentDriverFailure {
  ok: false;
  /** Short, single-line reason. Lands in `agent_runs.error` and in the alert to the top agent. */
  error: string;
  /** Optional long body kept in `agent_runs.result` for the UI (hints, remediation, raw payload). */
  detail?: string;
}

/** What a driver/builtin handler may return: result text (= success) or an explicit failure. */
export type AgentDriverResult = string | AgentDriverFailure;

export interface AgentDriver {
  /** Stable handler id, e.g. "cinema:cache-warmer". Matches agents.builtin_handler. */
  handler: string;
  /** Human name for the seeded agent row. */
  name: string;
  description: string;
  /** Cron expression. When present the generic seeder creates/repairs the agent + schedule. */
  cron?: string;
  /** Flow (office) name to group the agent under. Defaults to "Automations". */
  flow?: string;
  /** Per-run timeout for the seeded agent row. Defaults to 120s. */
  timeout_ms?: number;
  /**
   * The handler body — no LLM. Returns a result string for the run log, or
   * `{ ok: false, error }` when the work failed. Throwing counts as a failure too.
   */
  run: () => Promise<AgentDriverResult>;
}

/** Contract every module must implement */
export interface KernelModule {
  name: string;
  initialize(ctx: ModuleContext): Promise<void>;
  getTools(): ToolDefinition[];
  /** Optional — modules can expose read-only resources alongside their tools.
   *  Backward-compatible: existing modules return `undefined` (no resources). */
  getResources?(): ResourceProvider[];
  /**
   * Optional — modules can expose RPC actions to register on the
   * `mtwRequest` channel (browser ↔ kernel WebSocket). Replaces the prior
   * pattern of bootstrap importing each module's `rpc-actions.ts` directly.
   * Backward-compatible: existing modules return `undefined`.
   */
  getRpcActions?():
    | import("./mtw/rpc-handler.js").RpcAction[]
    | Promise<import("./mtw/rpc-handler.js").RpcAction[]>;
  /**
   * Optional — extensions contribute their slice of dashboard RPC actions.
   * The bootstrap collects these after loadActiveExtensions() and registers
   * them with mtwRpc, same pattern as getRpcActions().
   *
   * Deps are passed-in services the slice needs. Each extension declares
   * its own deps shape — keep it tight (don't accept the whole kitchen sink).
   */
  getDashboardRpcActions?(deps?: any): import("./mtw/rpc-handler.js").RpcAction[];
  /**
   * Optional — modules can register snapshot query handlers for the
   * mtwRequest publisher's channel switch. Each entry maps a channel name
   * to an async function that returns the snapshot payload. This lets the
   * bootstrap avoid hardcoding a `switch (channel)` block for every
   * built-in module.
   */
  getQueryChannels?(): Record<string, () => Promise<unknown> | unknown> | undefined;
  /**
   * Optional — extensions contribute named agent handlers. Bootstrap collects
   * these post-loadActiveExtensions() and the builtin-handlers factory queries
   * the registry by handler name instead of dynamic-importing extension paths.
   *
   * Each entry: handler name (matches the `kind` field in agent_handlers table)
   * → factory that returns the handler instance. Lazy: only built when the
   * agent runs. The returned shape is opaque — builtin-handlers narrows it
   * to the expected helper bundle (e.g. `{ analyzeStrategy, executeTrades }`).
   */
  getAgentHandlers?(): Record<string, () => Promise<unknown>>;
  /**
   * Optional — modules contribute complete scheduled agent drivers (handler id
   * + metadata + ready-to-run closure). Bootstrap collects these after
   * loadActiveExtensions() via `ModuleRegistry.collectAgentDrivers()`, merges
   * the `run` closures into the scheduler/executor builtin-handler map, and
   * feeds the defs to the generic driver seeder so each def with a `cron`
   * gets an idempotent `agents` row. Complements `getAgentHandlers()` (the
   * lazy code-bundle channel) — a module can use either or both.
   */
  getAgentDrivers?(): AgentDriver[];
  shutdown(): Promise<void>;
}

// ── Extension System (self-registering modules) ──────────

/** A single dashboard data channel that a module can register */
export interface DashboardChannel {
  name: string;
  query: (db: SqliteDb, neo4j: Neo4jClient) => Promise<unknown> | unknown;
}

/** Navigation item for the frontend sidebar */
export type LocalizedText = string | Record<string, string>;

export interface DashboardNavItem {
  id: string;
  /** Plain string, or a `{ locale: text }` map when the manifest localizes it.
   *  The dashboard resolves it; the kernel only carries it. */
  label: LocalizedText;
  icon: string;
  group: string;
  order?: number;
  /**
   * URL override. If set, clicking the item navigates here instead of `/${id}`.
   * Supports query strings (e.g. "/commander?path=/app/data").
   */
  path?: string;
  /**
   * If set, this item is a sub-tab that renders only when `parent` is the
   * current top-level view. Lets extensions add intra-page tabs without
   * touching the hardcoded sub-tab UI of the owning page.
   */
  parent?: string;
  /**
   * Backing module this nav item requires to be active. Suite stubs declare
   * nav for features whose id doesn't match their module id (e.g. `mail` →
   * `ext:comms`) or that ship no backend at all (`house`, `cameras`). The
   * dashboard hides the item unless this module is present in the manifest's
   * `modules` list, so the sidebar reflects only installed features. Omit for
   * items whose id already resolves (matching module, extPage, or core route).
   */
  requires?: string;
}

/** Top-level sidebar group. Extensions can contribute new groups dynamically. */
export interface DashboardNavGroup {
  id: string;
  /** Plain string, or a `{ locale: text }` map — see DashboardNavItem.label. */
  label: LocalizedText;
  icon: string;
  order?: number;
  /** If true, clicking the group header opens this specific view instead of the first. */
  defaultView?: string;
}

/** Maps a module's tool prefix to the WS channels it should refresh */
export interface ModuleChannelMapping {
  moduleKey: string;
  channels: string[];
}

/** Static HTML page served by a module */
export interface DashboardPage {
  /** URL path, e.g. "/lights-setup" */
  path: string;
  /** Absolute path to the HTML file on disk */
  filePath: string;
}

/**
 * A custom tab an extension contributes to the 3D agent/office panel.
 * The metadata (id/label/match/order) travels declaratively via the manifest;
 * the dashboard binds `id` → a Svelte component through its panel-tab registry.
 */
export interface AgentPanelTab {
  /** Unique id; also the registry key the dashboard uses to bind the component. */
  id: string;
  /** Tab button label (may include an emoji). */
  label: string;
  /**
   * When to show the tab. `office` matches the selected flow/office name.
   * Omit `match` entirely to show the tab on every agent panel.
   */
  match?: { office?: string };
  /** Sort order among contributed tabs (lower first). Default 100. */
  order?: number;
}

/** Descriptor returned by self-registering modules */
export interface DashboardDescriptor {
  nav?: DashboardNavItem[];
  /** New sidebar groups contributed by this module. Merged before the hardcoded defaults. */
  navGroups?: DashboardNavGroup[];
  channels?: DashboardChannel[];
  channelMappings?: ModuleChannelMapping[];
  registerRoutes?: (server: KernelHttpServer, db: SqliteDb, neo4j: Neo4jClient) => void;
  stores?: string[];
  fetchEndpoints?: Array<{ url: string; store: string }>;
  /** Static HTML pages this module serves */
  pages?: DashboardPage[];
  /** Custom tabs contributed to the 3D agent/office panel. */
  agentPanelTabs?: AgentPanelTab[];
}

/** Module that can optionally provide dashboard integration */
export interface ExtensibleModule extends KernelModule {
  getDashboardDescriptor?(): DashboardDescriptor | null;
}

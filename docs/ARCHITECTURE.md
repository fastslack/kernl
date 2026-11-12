# Architecture Guide

Read this before your first PR — it is the fastest way to understand a codebase
with 71 modules and 290 MCP tools without reading all of it. The orientation is
here at the top; the subsystem internals, data flows and step-by-step module
recipe follow.

For the migration this repo is in the middle of — "minimal kernel, everything
else an extension" — see [`architecture/`](./architecture/), which tracks the
phases, the deprecations audit and the handoff notes. It is a plan, not a
description of today.

## The 30-second model

Kernl is an **MCP server**. It exposes ~290 tools (`kernel_{module}_{action}`)
over two transports — stdio and Streamable HTTP — backed by SQLite (primary) and
a built-in graph (Relate, an embedded Cypher engine on a file next to the SQLite
database; Neo4j is an optional alternative). Everything else is a **module** or an **extension** that
plugs into that core. You almost never touch the core to add a feature; you add a
module or an extension.

```
services/kernel/bin/mcp-server.ts        → entry point, calls bootstrap()
services/kernel/src/index.ts             → bootstrap(): DB init, module registration, MCP + HTTP servers
services/kernel/src/server.ts            → MCP server + McpHttpRouter (Streamable HTTP sessions)
services/kernel/src/core/                → framework: config, logger, DB clients, HTTP server, auth, types
services/kernel/src/modules/{name}/      → built-in feature modules (self-contained)
services/kernel/assets/extensions/{cat}/ → marketplace extensions (loaded at runtime from prebuilt bundles)
services/dashboard/                      → SvelteKit SPA (separate build, served by nginx)
services/kernel/tests/                   → bun tests (in-memory SQLite; graph via a fake or an in-memory Relate store)
```

## Runtime conventions

- **Bun** (not Node) is the runtime — scripts use `bun`, imports use the `.js`
  extension (ESM, `moduleResolution Node16`), TypeScript strict.
- **SQLite** via `bun:sqlite`/better-sqlite3 is the source of truth. Money is
  always integer cents; booleans are `INTEGER 0/1`; deletes are soft
  (`deleted_at`). Several columns are `NOT NULL DEFAULT ''` — check presence with
  `<> ''`, not `IS NOT NULL`.
- **The graph** comes from the active graph driver (`ctx.graph`): `relate`
  (built in, the default), `neo4j` (optional server) or `noop` (graph off).
  Always guard with `graph?.capabilities.cypher` before graph calls, and gate
  Graph Data Science work on `capabilities.gds` — only Neo4j has it.
  `ctx.neo4j` is the deprecated legacy client. See [The graph layer](#the-graph-layer).

## Extensions vs. modules

Built-in modules live in `services/kernel/src/modules/` and compile with the
kernel. **Extensions** live in
`services/kernel/assets/extensions/<category>/<slug>/` and are loaded at runtime
from a prebuilt `backend/entry.js` bundle. After editing extension source you
must run `bun run build:extensions` or the kernel runs the stale bundle. The core
never imports extension source directly — it talks to them through structural
interfaces in `services/kernel/src/core/extension-seams.ts`.

## Security model

Single-user, self-hosted by default. Key invariants (see `SECURITY.md` and the
`/api` + `/mcp` auth gates in `services/kernel/src/server.ts` /
`services/kernel/src/core/http-server.ts`):

- The HTTP API and `/mcp` require `Authorization: Bearer $KERNEL_AUTH_TOKEN`.
  If no token is configured the kernel **generates and persists one** at first
  boot (mode-600 file next to the DB) rather than running open. Every shipped
  stack, including the Docker quick start, runs authenticated;
  `KERNEL_ALLOW_UNAUTH=1` exists only as a deliberate local-development escape
  hatch. Binding to loopback is **not** a substitute for it — the user's own
  browser is inside the loopback boundary.
- CORS is deny-by-default: `Access-Control-Allow-Origin` is sent only for an
  origin explicitly listed in `CORS_ALLOWED_ORIGINS`.
- The encryption key (`KERNEL_ENCRYPTION_KEY`) is likewise auto-generated and
  persisted if unset; at-rest secrets use AES-256-GCM.
- Untrusted input that reaches `fetch`, the shell, `import()`, or a DB column
  goes through a guard (`guardedFetch`/url-guard, `execFile` argv form,
  path-containment checks, column allowlists). When in doubt, fail closed.

## Where to start

- **Add a tool to an existing module** → `services/kernel/src/modules/<name>/tools.ts`
  + `service.ts`, plus a test in `services/kernel/tests/`. The module pattern is
  below; the seven-step recipe is under "Adding a New Module".
- **Add a new module** → copy the smallest existing module, register it in
  `services/kernel/src/index.ts`.
- **Add an extension** → see a sibling under
  `services/kernel/assets/extensions/<category>/` for the `extension.json` +
  `_module/` shape, then `bun run build:extensions`.
- **Run the stack** → `docker compose up -d --build`, then open
  `http://localhost:3086`. Or `bun run dev` for stdio MCP.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for workflow and [`FAQ.md`](./FAQ.md)
for common setup questions.

## System Overview

```
Claude Desktop / API clients
        |
        v
  MCP Protocol (stdio or HTTP)
        |
        v
  ┌─────────────────────────────────────────────┐
  │              Kernl                       │
  │                                              │
  │  ┌─────────┐  ┌──────────┐  ┌────────────┐ │
  │  │ Modules  │  │ EventBus │  │ Notifier   │ │
  │  │ (48)     │──│ (pub/sub)│──│ (7 channels│ │
  │  │          │  │          │  │  Telegram,  │ │
  │  │ tasks    │  └──────────┘  │  Slack,...) │ │
  │  │ crm      │                └────────────┘ │
  │  │ reminders│  ┌──────────┐  ┌────────────┐ │
  │  │ shopping │  │ SQLite   │  │ Graph      │ │
  │  │ home     │  │ (primary)│  │ (Relate,   │ │
  │  │          │  │          │  │  built in) │ │
  │  │ events   │  └──────────┘  └────────────┘ │
  │  │ ...      │                               │
  │  └─────────┘  ┌──────────────────────────┐  │
  │               │ HTTP Server              │  │
  │               │ /api/*  REST endpoints   │  │
  │               │ /ws     WebSocket hub    │  │
  │               │ /mcp    MCP HTTP sessions│  │
  │               └──────────────────────────┘  │
  └─────────────────────────────────────────────┘
        |
        v
  Dashboard (SvelteKit SPA on Nginx)
```

## The graph layer

Kernl keeps rows in SQLite and relationships in a graph. The graph comes from a
pluggable **graph driver** (`core/db-drivers/`); exactly one is active, chosen
in `/extensions`:

| Driver | What it is | Capabilities |
|---|---|---|
| `relate` (default) | [Relate](https://relatedb.ai), an embedded Cypher 25 engine running inside the kernel on `data/graph`. No server, no port, no password. | Cypher, vector + full-text indexes. No GDS. |
| `neo4j` (optional) | A Neo4j 5.x server — `docker-compose.neo4j.yml` adds one. | Cypher, vectors, Graph Data Science. |
| `noop` | Graph off; graph writes are skipped. | None. |

A fresh install starts on `relate` whenever its client is present (the desktop
app and the Docker image ship it), or on `neo4j` when `NEO4J_URI` points at a
server. Seeding never overrides a driver already chosen. The kernel dials no
Neo4j unless `NEO4J_URI` is set. `scripts/relate-migrate.sh` copies a Neo4j
graph into a Relate store.

Rules for graph code:

- Write Cypher that runs on both engines: no `apoc.*`, no options map on
  `db.index.fulltext.queryNodes` (use `LIMIT`), read counts with `Number(v)` or
  `.toNumber()`.
- Large vector collections do not belong in the graph: Relate keeps the whole
  graph in memory. Cinema's 165k title vectors live in SQLite and are searched
  in-process (`cinema/_module/vector-store.ts`).
- SQLite stays the source of truth. Graph projections rebuild from it: a module
  that writes graph nodes offers `getGraphBackfill()`, run once per store
  (`core/graph-backfill.ts`), and every Cypher statement is planned against
  Relate in `tests/cypher-corpus.test.ts`.
- The graph lives in memory; `RELATE_LOGICAL_GRAPH_SIZE_LIMIT` (default 2gib,
  or "Memory limit" in /extensions) refuses growth past it instead of letting
  the kernel run out of memory.

### How agents learn

1. Before a run, the system prompt carries the agent's own learnings and —
   from the **shared experience graph** — learnings of *other* agents that fit
   the goal: found by vector similarity (full-text when vectors are not
   comparable), ranked by relevance, confidence, shared tools and shared office.
   Another agent's learning is third-party text: it reaches the prompt inside
   `<external trust="untrusted">`, as data rather than instruction, and one the
   prompt-injection detector flags is left out.
2. The prompt records which learnings it carried (`agent_run_learnings`).
3. After the run, an LLM grades it (`AGENTS_EVAL_PROVIDER`) and may extract a
   new learning. Three failed gradings in a row notify the user.
4. Grading credits or blames exactly the learnings that run carried; a failure
   never weakens an `avoid` learning.
5. The graph syncs incrementally: `(Agent)-[:RAN]->(AgentRun)-[:USED]->(AgentTool)`,
   `(Agent)-[:LEARNED]->(AgentLearning)-[:DERIVED_FROM]->(AgentRun)`.
   `USED.errors` counts failed tool results.
6. The prompt also names the tools the agent is about to use that failed in a
   good share of recent runs across the fleet, with the last error as external
   data (`toolFailureWarnings` in `executor/system-prompt.ts`).

### Memory, facts, people and provenance

- **`kernel_brain_ask`** (`modules/brain/ask.ts`) — one question over every
  memory: brain items, chat messages and memories, agent learnings, current
  facts and graph entities (full-text index `kernl_entity_text`), each searched
  by meaning and by words, fused with Reciprocal Rank Fusion and expanded one
  hop in the graph. Each leg queries vectors with the model that wrote them.
- **Facts** (`modules/brain/facts.ts`, table `facts`) — subject, predicate,
  value with two timelines: when it was true (`valid_from`/`valid_to`) and when
  Kernl believed it (`recorded_at`/`superseded_at`). A new value ends the old
  one (change) or replaces it (correction); nothing is deleted. Projected as
  `(:Fact)-[:ABOUT]->(subject)` with `REPLACES` links.
- **People** (`crm/_module/people.ts`) — `contact_identities` holds every email,
  phone and handle of a contact; `kernel_crm_duplicates`, `kernel_crm_merge`
  (repoints every `contact_id` column, facts and graph relationships, keeps a
  snapshot in `contact_merges`) and `kernel_crm_person_360`.
- **Provenance** (`modules/provenance/`, table `tool_provenance`) — every tool
  call that writes, from MCP or a native agent run, with who made it and the
  ids it touched; `kernel_audit_who_changed`. A run is linked to what it
  touched: `(:AgentRun)-[:TOUCHED]->(n)`.
- **Graph queries for agents** (`modules/graph-query/`) — `kernel_graph_schema`,
  `kernel_graph_query` (read-only, checked by text, by the planner's EXPLAIN and
  against the schema) and `kernel_graph_ask` (a question → Cypher through the
  LLM driver, corrected from those errors). The embedded engine cannot cancel a
  query: one that runs out of time blocks new ones until it ends.

## Module Pattern

Every module is a self-contained unit with a standard structure:

```
services/kernel/src/modules/{name}/
  index.ts              Factory function → KernelModule
  service.ts            Business logic (CRUD, queries)
  tools.ts              MCP tool definitions (Zod schemas)
  types.ts              TypeScript interfaces
  migrations.ts         SQLite schema (versioned)
  dashboard-queries.ts  Dashboard data queries (optional)
```

### Factory Function

```typescript
import type { KernelModule, ModuleContext } from "../../core/types.js";
import { runMigrations } from "../../core/db/migrations.js";

export function createFooModule(): KernelModule {
  let tools: ToolDefinition[] = [];

  return {
    name: "foo",

    async initialize(ctx: ModuleContext) {
      // 1. Run migrations (create tables)
      runMigrations(ctx.sqlite, "foo", fooMigrations);

      // 2. Create service with dependencies
      const service = new FooService(ctx.sqlite, ctx.neo4j);

      // 3. Build tools array
      tools = fooTools(service);
    },

    getTools() { return tools; },
    async shutdown() { /* cleanup */ },
  };
}
```

### ModuleContext

Every module receives:

```typescript
interface ModuleContext {
  sqlite: SqliteDb;          // SQLite database
  graph: GraphDriver | null; // Active graph driver (live) — guard with graph?.capabilities.cypher
  neo4j: Neo4jClient;        // @deprecated legacy Neo4j client
  events: EventBus;          // Pub/sub event system
  config: KernelConfig;      // Full configuration
  systemRegistry: SystemRegistry;  // Process/worker tracking
  notifier: Notifier;        // Multi-channel notifications
}
```

### Tool Definition

```typescript
export const fooTools = (service: FooService): ToolDefinition[] => [
  {
    name: "kernel_foo_create",
    description: "Create a new foo",
    inputSchema: z.object({
      title: z.string().describe("Foo title"),
      priority: z.enum(["low", "medium", "high"]).optional(),
    }),
    handler: async (input) => {
      const result = service.create(input.title, input.priority);
      return textResult(`Created foo: ${result.title} (${result.id})`);
    },
  },
];
```

## Adding a New Module

### Step 1: Create the directory

```bash
mkdir services/kernel/src/modules/my-module
```

### Step 2: Define types (`types.ts`)

```typescript
export interface MyItem {
  id: string;
  title: string;
  created_at: string;
}
```

### Step 3: Create migrations (`migrations.ts`)

```typescript
import type { Migration } from "../../core/db/migrations.js";

export const myModuleMigrations: Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS my_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  },
];
```

### Step 4: Create service (`service.ts`)

```typescript
import type { SqliteDb } from "../../core/db/sqlite.js";
import { newId, isoNow } from "../../core/helpers.js";

export class MyModuleService {
  constructor(private db: SqliteDb) {}

  create(title: string) {
    const id = newId();
    const now = isoNow();
    this.db.prepare(
      "INSERT INTO my_items (id, title, created_at) VALUES (?, ?, ?)"
    ).run(id, title, now);
    return { id, title, created_at: now };
  }

  list() {
    return this.db.prepare("SELECT * FROM my_items ORDER BY created_at DESC").all();
  }
}
```

### Step 5: Create tools (`tools.ts`)

```typescript
import { z } from "zod";
import type { ToolDefinition } from "../../core/types.js";
import { textResult, errorResult } from "../../core/helpers.js";
import type { MyModuleService } from "./service.js";

export const myModuleTools = (service: MyModuleService): ToolDefinition[] => [
  {
    name: "kernel_mymodule_create",
    description: "Create a new item",
    inputSchema: z.object({ title: z.string() }),
    handler: async (input) => {
      const item = service.create(input.title);
      return textResult(`Created: ${item.title}`);
    },
  },
  {
    name: "kernel_mymodule_list",
    description: "List all items",
    inputSchema: z.object({}),
    handler: async () => {
      const items = service.list();
      return textResult(items.map((i: any) => `- ${i.title}`).join("\n") || "No items.");
    },
  },
];
```

### Step 6: Create module entry (`index.ts`)

```typescript
import type { KernelModule } from "../../core/types.js";
import { runMigrations } from "../../core/db/migrations.js";
import { myModuleMigrations } from "./migrations.js";
import { MyModuleService } from "./service.js";
import { myModuleTools } from "./tools.js";

export function createMyModule(): KernelModule {
  let tools: ToolDefinition[] = [];
  return {
    name: "my-module",
    async initialize(ctx) {
      runMigrations(ctx.sqlite, "my-module", myModuleMigrations);
      const service = new MyModuleService(ctx.sqlite);
      tools = myModuleTools(service);
    },
    getTools() { return tools; },
    async shutdown() {},
  };
}
```

### Step 7: Register in bootstrap (`services/kernel/src/index.ts`)

```typescript
import { createMyModule } from "./modules/my-module/index.js";
// In bootstrap():
registry.register(createMyModule());
```

## Database Conventions

- **IDs**: UUIDv4 via `newId()`
- **Timestamps**: ISO 8601 UTC via `isoNow()`
- **NOT NULL defaults**: Use `NOT NULL DEFAULT ''` for text fields (never null strings)
- **Check presence**: Use `column <> ''` (not `IS NOT NULL`)
- **Money**: Store as INTEGER cents, display with `formatCents()`
- **Soft deletes**: `deleted_at TEXT` column (nullable)
- **Migrations**: Versioned per module, idempotent, additive only

## Event System

```typescript
// Emit an event
ctx.events.emit("contact.interaction", { contact_id, type: "email" });

// Listen for events (in event-listeners.ts or module initialize)
ctx.events.on("events:confirmed", async (payload) => {
  // Cross-module reaction
});
```

Event naming: `module:action` (e.g., `events:created`, `trading:order_filled`)

## Dashboard Integration

Each module can provide dashboard data by creating `dashboard-queries.ts`:

```typescript
import type { SqliteDb } from "../../core/db/sqlite.js";
import { tableExists } from "../../core/db/query-helpers.js";

export interface DashboardMyModule {
  total: number;
  recent: Array<{ id: string; title: string }>;
}

export function queryMyModule(db: SqliteDb): DashboardMyModule | null {
  if (!tableExists(db, "my_items")) return null;
  const total = (db.prepare("SELECT COUNT(*) as c FROM my_items").get() as { c: number }).c;
  const recent = db.prepare("SELECT id, title FROM my_items ORDER BY created_at DESC LIMIT 5").all();
  return { total, recent };
}
```

Then re-export from `dashboard/api.ts` and register the route in `api-routes.ts`.

## Testing

Tests use in-memory SQLite (`:memory:`), no external dependencies:

```typescript
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

describe("MyModule", () => {
  it("creates an item", () => {
    const db = new Database(":memory:");
    // Run migrations, create service, test...
  });
});
```

Run: `bun test` or `npx vitest run`

## Key Files Reference

| File | Purpose |
|------|---------|
| `services/kernel/bin/mcp-server.ts` | Entry point |
| `services/kernel/src/index.ts` | Bootstrap (DB, modules, HTTP, WS) |
| `services/kernel/src/server.ts` | MCP server + HTTP session router |
| `services/kernel/src/core/config.ts` | Configuration loading |
| `services/kernel/src/core/types.ts` | Core interfaces (KernelModule, ToolDefinition) |
| `services/kernel/src/core/helpers.ts` | Utilities (textResult, newId, isoNow) |
| `services/kernel/src/core/http-server.ts` | HTTP server with auth + rate limiting |
| `services/kernel/src/core/event-bus.ts` | Pub/sub event system |
| `services/kernel/src/core/db/sqlite.ts` | SQLite connection |
| `services/kernel/src/core/db-drivers/graph-driver.ts` | Graph driver contract + capabilities |
| `services/kernel/src/core/db-drivers/builtins/relate-graph-driver.ts` | Built-in graph (Relate, embedded) |
| `services/kernel/src/core/db-drivers/builtins/neo4j-graph-driver.ts` | Optional Neo4j server driver |
| `services/kernel/src/modules/agents/services/experience-graph.ts` | Shared experience graph for agents |
| `services/kernel/src/core/db/neo4j.ts` | Legacy Neo4j client (deprecated) |
| `services/kernel/src/core/db/query-helpers.ts` | Shared query utilities (safeGet, safeAll, tableExists) |

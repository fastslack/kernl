# Architecture

A map of Kernl for contributors. Read this before your first PR — it's the
fastest way to understand a codebase with 71 modules and 290 MCP tools without
reading all of it. For the full system guide (subsystem internals, data flows,
deployment topologies), see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## The 30-second model

Kernl is an **MCP server**. It exposes ~290 tools (`kernel_{module}_{action}`)
over two transports — stdio and Streamable HTTP — backed by SQLite (primary) and
an optional Neo4j graph. Everything else is a **module** or an **extension** that
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
services/kernel/tests/                   → vitest/bun tests (in-memory SQLite, Neo4j unavailable)
```

## Runtime

- **Bun** (not Node) is the runtime — scripts use `bun`, imports use the `.js`
  extension (ESM, `moduleResolution Node16`), TypeScript strict.
- **SQLite** via `bun:sqlite`/better-sqlite3 is the source of truth. Money is
  always integer cents; booleans are `INTEGER 0/1`; deletes are soft
  (`deleted_at`). Several columns are `NOT NULL DEFAULT ''` — check presence with
  `<> ''`, not `IS NOT NULL`.
- **Neo4j** is optional and degrades gracefully — always guard with
  `neo4j.available` before graph calls.

## Anatomy of a module

Every built-in module exports a factory returning a `KernelModule`:

```typescript
export function createFooModule(): KernelModule {
  let tools: ToolDefinition[] = [];
  return {
    name: "foo",
    async initialize(ctx: ModuleContext) {       // ctx = { sqlite, neo4j, events, config }
      runMigrations(ctx.sqlite, "foo", fooMigrations);
      const service = new FooService(ctx.sqlite, ctx.neo4j);
      tools = fooTools(service);                  // ToolDefinition[] with Zod inputSchema
    },
    getTools() { return tools; },
    async shutdown() {},
  };
}
```

- **Tools** are `ToolDefinition`s: a name (`kernel_foo_create`), a Zod
  `inputSchema` (converted to JSON Schema for MCP), and a handler returning
  `textResult(markdown)` or `errorResult(msg)`.
- **Migrations** are `{ version, sql }` arrays, applied idempotently by
  `runMigrations`.
- IDs come from `newId()` (UUIDv4); timestamps from `isoNow()` (ISO-8601 UTC).

## Extensions vs. modules

Built-in modules live in `services/kernel/src/modules/` and compile with the kernel. **Extensions**
live in `services/kernel/assets/extensions/<category>/<slug>/` and are loaded at runtime from a
prebuilt `backend/entry.js` bundle. After editing extension source you must run
`bun run build:extensions` or the kernel runs the stale bundle. The core never
imports extension source directly — it talks to them through structural
interfaces in `services/kernel/src/core/extension-seams.ts`.

## Security model

Single-user, self-hosted by default. Key invariants (see `SECURITY.md` and the
`/api` + `/mcp` auth gates in `services/kernel/src/server.ts` / `services/kernel/src/core/http-server.ts`):

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

- **Add a tool to an existing module** → `services/kernel/src/modules/<name>/tools.ts` +
  `service.ts`. Add a test in `services/kernel/tests/`.
- **Add a new module** → copy the smallest existing module, register it in
  `services/kernel/src/index.ts`.
- **Add an extension** → `services/kernel/assets/extensions/<category>/<slug>/`; see a sibling
  for the `extension.json` + `_module/` + `_wrapper/` shape; `bun run
  build:extensions`.
- **Run the stack** → `docker compose up -d --build`
  then open `http://localhost:3086`. Or `bun run dev` for stdio MCP.

See `docs/CONTRIBUTING.md` for workflow and `docs/FAQ.md` for common setup
questions.

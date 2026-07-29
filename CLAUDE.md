<project name="Kernl">
<description>Personal Life Management MCP Server — tasks, CRM, reminders, shopping, dashboard, graph intelligence, Google sync, and 30+ feature modules.</description>

<stack>
- **Runtime**: Node.js >=20, ESM (`"type": "module"`)
- **Language**: TypeScript (strict), target ES2022, moduleResolution Node16
- **Databases**: better-sqlite3 (primary), Neo4j 5.x + GDS (graph, graceful degradation) — via Docker Compose
- **Protocol**: MCP (Model Context Protocol) via `@modelcontextprotocol/sdk` — dual transport: stdio + Streamable HTTP
- **Validation**: Zod schemas (converted to JSON Schema for MCP via `zodToJsonSchema()`)
- **Testing**: vitest (in-memory SQLite, Neo4j unavailable by default)
- **Embeddings**: `@huggingface/transformers` — local ONNX model `Xenova/all-MiniLM-L6-v2` (384d)
- **Notifications**: Multi-channel via NotificationRegistry (Mattermost, Telegram, Dashboard, WhatsApp, Slack, Discord, WebChat) — marketplace-driven, factory pattern
</stack>

<conventions>
- **Imports**: Always use `.js` extension in imports (ESM Node16 requirement)
- **Tool naming**: `kernel_{module}_{action}` (e.g., `kernel_tasks_create`)
- **IDs**: `newId()` → UUIDv4
- **Timestamps**: `isoNow()` → ISO 8601 UTC
- **Results**: `textResult(markdown)` for success, `errorResult(msg)` for errors
- **Neo4j guard**: Always check `graph?.capabilities.cypher` before graph operations; `neo4j.available` is legacy/deprecated
- **Zod schemas**: Used as `inputSchema` in ToolDefinition
- **Money**: Always INTEGER cents in SQLite. Use `formatCents()` for display.
- **Soft deletes**: `deleted_at TEXT` nullable — filter with `deleted_at IS NULL`
- **Booleans**: `INTEGER NOT NULL DEFAULT 0` (0/1)
- **Bash commands**: NEVER chain commands with `&&`, `||`, or pipes in a single Bash call. Run each as a separate call.
- **LLM calls — one door only**: every LLM call in the kernel and in every paid
  extension goes through the driver, `llm()` from `src/core/llm/client.ts`
  (or `createPinnedLlmClient()` when a call must address one specific provider,
  e.g. benchmarking). NEVER instantiate a provider SDK, call a provider REST
  endpoint, or read a provider API key directly from a module or an extension.
  Going around the driver loses the whole chain: provider fallback, health-based
  reordering, the 429 concurrency limiter, retries, the call log and the usage
  accounting. Per-feature model choice belongs in the `model:` option (backed by
  a `*_MODEL` setting), never in a new client. Always pass a `caller:` tag so the
  call is attributable.
</conventions>

<module-pattern>
Every module exports a factory function returning `KernelModule`:

```typescript
export function createFooModule(): KernelModule {
  let tools: ToolDefinition[] = [];
  return {
    name: "foo",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "foo", fooMigrations);  // if has tables
      const service = new FooService(ctx.sqlite, ctx.neo4j);
      tools = fooTools(service);
    },
    getTools() { return tools; },
    async shutdown() {},
  };
}
```

**ModuleContext**: `{ sqlite, neo4j, events, config }`

Migrations use `Migration { version: number; sql: string }` arrays, located in:
- `services/kernel/src/modules/{name}/migrations/*.ts` (directory pattern), or
- `services/kernel/src/modules/{name}/migrations.ts` (inline pattern)
</module-pattern>

<critical-gotchas>

**SQLite NOT NULL columns with empty defaults:**
`contacts` table: `email`, `phone`, `company`, `notes` are `NOT NULL DEFAULT ''`.
Use `<> ''` to check for presence, **NOT** `IS NOT NULL`.
Same pattern used in many other tables (communications, events, etc.)

**Google sync source column:**
`source` column lives in `google_sync_map` table, NOT in `contacts` — join via `local_id = contacts.id`.

**Neo4j shared database (SNOMED CT):**
The Neo4j database is shared with a medical ontology (~3.4M nodes).
**All queries MUST filter by Kernl nodes** using `p.relationship IS NOT NULL` or similar properties.
Never use unfiltered `MATCH (n)` — it will scan SNOMED nodes too.

**LifeService created in bootstrap:**
`LifeService` is created in `bootstrap()` (services/kernel/src/index.ts), not inside a module — passed to `registerDashboardRoutes()`.

**google_sync_map may not exist:**
`queryAnalytics()` gracefully handles missing `google_sync_map` table.
Analytics tools are only registered when `analyticsService` is not null (i.e., Neo4j available).

</critical-gotchas>

<key-architecture>
```
services/kernel/               → Paquete kernel completo (package.json, src, bin, scripts, assets, tests)
services/kernel/bin/mcp-server.ts   → Entry point, calls bootstrap()
services/kernel/src/index.ts        → bootstrap(): DB init, module registration, MCP + HTTP servers
services/kernel/src/server.ts       → MCP server + McpHttpRouter (Streamable HTTP sessions)
services/kernel/src/core/           → Framework: config, logger, DB clients, HTTP server, types
services/kernel/src/modules/{name}/ → Feature modules (self-contained)
services/kernel/tests/              → vitest tests
services/kernel/scripts/            → CLI scripts del kernel
services/dashboard/            → SvelteKit SPA (nginx la sirve en Docker)
services/searxng/settings.yml  → Config SearXNG (única, la montan ambos stacks)
docker-compose*.yml            → Orquestación (raíz); package.json raíz delega npm run dev/test/lint
```

Use `/schema <module>` to see full SQL schemas on demand.
Use `/arch` to discover modules, tools, API routes, and project structure.
</key-architecture>

<docker-compose>
| Service | Host Port | URL |
|---------|-----------|-----|
| Neo4j Browser | **17474** | `http://localhost:17474` |
| Neo4j Bolt | **17687** | `bolt://localhost:17687` |
| Dashboard/MCP HTTP | **3086** | `http://localhost:3086` |
</docker-compose>

<scripts>
```bash
# Desde la raíz (delegan a services/kernel/) o directamente dentro de services/kernel/:
npm run dev           # Start MCP server (stdio)
npm run build         # Compile TypeScript
npm test              # Run vitest
npm run lint          # Type-check only (tsc --noEmit)
```
</scripts>

<testing>
Tests use in-memory SQLite (`:memory:`) and Neo4j in unavailable state (`neo4j.available = false`).
- Use empty strings `""` instead of `null` for NOT NULL DEFAULT '' columns
- `life_log` table only exists if life migrations are run — life-queries use try/catch
</testing>

</project>

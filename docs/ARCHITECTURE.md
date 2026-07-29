# Architecture Guide

The full system guide. If you just want the quick contributor map (where
things live, how to add a module), start with the shorter
[`ARCHITECTURE-MAP.md`](./ARCHITECTURE-MAP.md).

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
  │  │ shopping │  │ SQLite   │  │ Neo4j      │ │
  │  │ home     │  │ (primary)│  │ (optional) │ │
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
  neo4j: Neo4jClient;        // Neo4j (check neo4j.available before use)
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
| `services/kernel/src/core/db/neo4j.ts` | Neo4j client (graceful degradation) |
| `services/kernel/src/core/db/query-helpers.ts` | Shared query utilities (safeGet, safeAll, tableExists) |

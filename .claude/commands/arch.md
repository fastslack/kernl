---
description: Discover project architecture — modules, tools, API routes, notification system
allowed-tools: Read, Glob, Grep, Bash
arguments:
  - name: scope
    description: "What to discover: 'modules', 'tools', 'routes', 'notifications', 'events', 'neo4j', or 'all' (default: all)"
    required: false
---

# Architecture Discovery: $ARGUMENTS

Dynamically discover the Kernl project structure by reading the actual code.

## Scope: modules (or all)

Discover all registered modules and their capabilities:

1. Read `services/kernel/src/index.ts` — find all `createXxxModule()` imports to get the module list and registration order
2. For each module, check:
   - Has migrations? (tables)
   - Has Neo4j usage? (grep for `neo4j` in service files)
   - Tool count: grep for tool definitions in `tools.ts`
3. Present as a table: | Module | Tables | Neo4j | Tools count | Description |

## Scope: tools (or all)

List all MCP tools:

1. Grep for `name: "kernel_` across `services/kernel/src/modules/*/tools.ts` files
2. Group by module
3. Present as: | Module | Tools |

## Scope: routes (or all)

Discover HTTP API routes:

1. Grep for route patterns (GET, POST, PUT, DELETE + `/api/`) in:
   - `services/kernel/src/modules/dashboard/api-routes.ts`
   - `services/kernel/src/modules/*/api-routes.ts`
   - `services/kernel/src/core/http-server.ts`
2. Present as: | Method | Endpoint | File |

## Scope: notifications (or all)

Discover the notification/channel system:

1. Read `services/kernel/src/core/notification-provider.ts` for the interface
2. Glob `services/kernel/src/core/providers/*.ts` for all provider implementations
3. Grep for `registerFactory` in `services/kernel/src/index.ts` to see registered factories
4. Present: | Provider | ID | Capabilities | Config Fields |

## Scope: events (or all)

Discover EventBus events:

1. Grep for `events.emit(` across all source files
2. Grep for `events.on(` in `services/kernel/src/core/event-listeners.ts`
3. Present: | Event | Emitted by | Listener action |

## Scope: neo4j (or all)

Discover Neo4j schema:

1. Grep for `CREATE.*INDEX` and node/relationship patterns in graph-intel and chat modules
2. Read `services/kernel/src/modules/graph-intel/enrichment.ts` for relationship creation
3. Read `services/kernel/src/modules/graph-intel/analytics.ts` for GDS algorithms
4. Present nodes, relationships, and vector indexes

## Output

Present results cleanly formatted in markdown tables. Only show the requested scope (default: all).

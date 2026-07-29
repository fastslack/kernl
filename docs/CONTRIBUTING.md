# Contributing to Kernl

Thank you for your interest in contributing! This guide will help you get started.

## Reporting Bugs

Open an issue using the [bug report template](https://github.com/fastslack/kernl/issues/new?template=bug_report.md). Include:
- Steps to reproduce the issue
- Expected vs actual behavior
- Environment details (OS, Node/Bun version)
- Relevant logs (redact secrets)

## Suggesting Features

Open an issue using the [feature request template](https://github.com/fastslack/kernl/issues/new?template=feature_request.md). Describe the problem you're solving and your proposed approach.

## Development Setup

### Prerequisites

- **Node.js >= 20** or **Bun >= 1.2**
- **Docker** (optional, for Neo4j graph analytics)
- **Git**

### Setup

```bash
git clone https://github.com/fastslack/kernl.git
cd Kernl
npm install        # or: bun install
cp .env.example .env
```

Edit `.env` with at minimum:

```env
SQLITE_PATH=./data/kernel.db
```

### Running

```bash
npm run dev        # Start MCP server (stdio mode)
npm run build      # Compile TypeScript
```

### Optional: Neo4j

```bash
docker compose up -d   # Starts Neo4j on bolt://localhost:17687
```

## Running Tests

Tests use in-memory SQLite and do not require Neo4j.

```bash
npm test           # or: bun test
```

## Type Checking

```bash
npx tsc --noEmit   # or: npm run lint
```

## Code Style

- **TypeScript strict mode** with `target: ES2022`
- **ESM only** (`"type": "module"` in package.json)
- **Always use `.js` extensions** in import paths (Node16 module resolution)
- **Zod** for input validation (converted to JSON Schema for MCP)
- **IDs**: `newId()` (UUIDv4)
- **Timestamps**: `isoNow()` (ISO 8601 UTC)
- **Results**: `textResult(markdown)` for success, `errorResult(msg)` for errors

## Module Pattern

Every module exports a factory function returning `KernelModule`:

```typescript
import type { KernelModule, ModuleContext, ToolDefinition } from "../../core/types.js";

export function createFooModule(): KernelModule {
  let tools: ToolDefinition[] = [];
  return {
    name: "foo",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "foo", fooMigrations);
      const service = new FooService(ctx.sqlite, ctx.neo4j);
      tools = fooTools(service);
    },
    getTools() { return tools; },
    async shutdown() {},
  };
}
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details.

## Pull Request Process

1. Fork the repository and create a feature branch from `main`
2. Write or update tests for your changes
3. Ensure all tests pass: `npm test`
4. Ensure type checking passes: `npx tsc --noEmit`
5. Follow the commit message convention (see below)
6. Open a PR against `main` with a clear description

## Commit Messages

Use conventional commits:

```
feat(tasks): add recurring task support
fix(crm): handle empty email in contact search
refactor(dashboard): extract KPI calculation
chore(deps): bump @modelcontextprotocol/sdk to 1.27
test(events): add waitlist promotion tests
docs: update module overview table
```

Format: `type(scope): description`

Types: `feat`, `fix`, `refactor`, `chore`, `test`, `docs`, `perf`, `ci`

## Questions?

Open a [discussion](https://github.com/fastslack/kernl/discussions) or reach out via an issue.

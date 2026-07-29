---
description: Show SQL schema for a module by reading its migration files
allowed-tools: Read, Glob, Grep, Bash
arguments:
  - name: module
    description: "Module name (e.g., 'tasks', 'crm', 'trading') or 'all' for a summary of all modules"
    required: true
---

# Schema Lookup: $ARGUMENTS

Look up the SQLite schema for the requested module(s) in this Kernl project.

## Instructions

1. If the argument is "all" or "list":
   - Use `Glob` to find all migration files: `services/kernel/src/modules/*/migrations/*.ts` and `services/kernel/src/modules/*/migrations.ts`
   - For each module, extract table names from CREATE TABLE statements
   - Present a summary table: | Module | Tables | Migration files |

2. If the argument is a specific module name:
   - Find migration files in `services/kernel/src/modules/{module}/migrations/*.ts` or `services/kernel/src/modules/{module}/migrations.ts`
   - Read ALL migration files for that module
   - Extract and present the complete SQL schema including:
     - CREATE TABLE statements (show full DDL)
     - CREATE INDEX statements
     - ALTER TABLE statements from later migrations (show as additions)
     - CHECK constraints and their allowed values
     - Foreign key relationships
   - Also note any critical patterns:
     - Columns that are `NOT NULL DEFAULT ''` (use `<> ''` to check, not `IS NOT NULL`)
     - Money columns stored as INTEGER cents
     - Soft delete columns (`deleted_at`)

3. Format output as clean SQL with comments explaining the migration version.

4. If the module is not found, list available modules.

## Important

- Migration files export arrays like `export const fooMigrations: Migration[]`
- Each migration has `{ version: number, sql: string }`
- Later versions may ALTER tables from version 1
- Present the cumulative schema (all versions combined)

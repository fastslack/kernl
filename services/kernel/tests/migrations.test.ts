import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations, type Migration } from "../src/core/db/migrations.js";

describe("migrations", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("runs migrations and records them", () => {
    const migrations: Migration[] = [
      { version: 1, sql: "CREATE TABLE test_table (id TEXT PRIMARY KEY)" },
    ];

    runMigrations(db, "test_mod", migrations);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'")
      .all();
    expect(tables).toHaveLength(1);

    const applied = db
      .prepare("SELECT * FROM _migrations WHERE module = 'test_mod'")
      .all() as Array<{ version: number }>;
    expect(applied).toHaveLength(1);
    expect(applied[0].version).toBe(1);
  });

  it("skips already-applied migrations", () => {
    const migrations: Migration[] = [
      { version: 1, sql: "CREATE TABLE t1 (id TEXT PRIMARY KEY)" },
      { version: 2, sql: "CREATE TABLE t2 (id TEXT PRIMARY KEY)" },
    ];

    runMigrations(db, "mod", migrations);
    // Run again — should not fail
    runMigrations(db, "mod", migrations);

    const applied = db
      .prepare("SELECT * FROM _migrations WHERE module = 'mod'")
      .all();
    expect(applied).toHaveLength(2);
  });

  it("applies migrations in version order", () => {
    const migrations: Migration[] = [
      { version: 3, sql: "CREATE TABLE t3 (id TEXT)" },
      { version: 1, sql: "CREATE TABLE t1 (id TEXT)" },
      { version: 2, sql: "CREATE TABLE t2 (id TEXT)" },
    ];

    runMigrations(db, "mod", migrations);

    const applied = db
      .prepare("SELECT version FROM _migrations WHERE module = 'mod' ORDER BY id")
      .all() as Array<{ version: number }>;
    expect(applied.map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it("rolls back a migration that fails partway, so a fixed retry applies cleanly", () => {
    const broken: Migration[] = [
      { version: 1, sql: "CREATE TABLE a (id TEXT); CREATE TABLE a (id TEXT);" },
    ];
    expect(() => runMigrations(db, "mod", broken)).toThrow();
    // Neither the first statement nor the bookkeeping survived.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS c FROM _migrations").get()).toEqual({ c: 0 });

    runMigrations(db, "mod", [{ version: 1, sql: "CREATE TABLE a (id TEXT);" }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toEqual({ name: "a" });
  });
});

// tests/panels-sources.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { panelsMigrations } from "../src/modules/panels/migrations.js";
import { PanelStore } from "../src/modules/panels/store.js";
import { readSource, SourceError } from "../src/modules/panels/sources.js";

describe("readSource", () => {
  let root: string;
  let outside: string;
  let store: PanelStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "panels-root-"));
    outside = mkdtempSync(join(tmpdir(), "panels-out-"));
    writeFileSync(join(root, "ledger.json"), JSON.stringify({ issues: { "web#1": { state: "ready", token: "s3" } } }));
    writeFileSync(join(outside, "secret.json"), JSON.stringify({ leak: true }));
    const db = new Database(":memory:");
    runMigrations(db, "panels", panelsMigrations);
    store = new PanelStore(db);
  });
  const ctx = () => ({ owner: "f1", rootDir: root, store });

  it("reads a state file and gives a version that moves when it changes", () => {
    const a = readSource({ type: "state-file", path: "ledger.json" }, ctx());
    expect((a.data as { issues: unknown }).issues).toBeDefined();
    writeFileSync(join(root, "ledger.json"), JSON.stringify({ issues: {}, more: 1 }));
    expect(readSource({ type: "state-file", path: "ledger.json" }, ctx()).version).not.toBe(a.version);
  });

  it("refuses a symlink that leaves the office folder", () => {
    symlinkSync(join(outside, "secret.json"), join(root, "link.json"));
    expect(() => readSource({ type: "state-file", path: "link.json" }, ctx())).toThrow(SourceError);
    mkdirSync(join(root, "sub"));
    symlinkSync(outside, join(root, "sub", "out"));
    expect(() => readSource({ type: "state-file", path: "sub/out/secret.json" }, ctx())).toThrow(SourceError);
  });

  it("reports a missing file, bad JSON and a schema mismatch as errors", () => {
    expect(() => readSource({ type: "state-file", path: "nope.json" }, ctx())).toThrow(/not found/);
    writeFileSync(join(root, "bad.json"), "{not json");
    expect(() => readSource({ type: "state-file", path: "bad.json" }, ctx())).toThrow(/not valid JSON/);
    expect(() => readSource({ type: "state-file", path: "ledger.json", schema: { type: "array" } }, ctx())).toThrow(/must be an array/);
  });

  it("strips secret fields declared in the schema", () => {
    const schema = { type: "object" as const, properties: { issues: { type: "object" as const, properties: { "web#1": { type: "object" as const, properties: { token: { type: "string" as const, secret: true } } } } } } };
    const r = readSource({ type: "state-file", path: "ledger.json", schema }, ctx());
    expect(JSON.stringify(r.data)).not.toContain("s3");
  });

  it("refuses a file over the size cap", () => {
    writeFileSync(join(root, "big.json"), JSON.stringify({ x: "a".repeat(1_100_000) }));
    expect(() => readSource({ type: "state-file", path: "big.json" }, ctx())).toThrow(/too large/);
  });

  it("reads a collection of the same owner only", () => {
    store.putRecord("f1", "events", "k1", { text: "hola" }, "a");
    store.putRecord("f2", "events", "k2", { text: "otro" }, "b");
    const r = readSource({ type: "collection", name: "events" }, ctx());
    expect(r.data).toEqual({ k1: { text: "hola", updated_at: expect.any(String), updated_by: "a" } });
  });
});

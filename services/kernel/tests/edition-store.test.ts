import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { readEditionState, writeEditionState, readEditionMode } from "../src/core/edition.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db, "extensions", extensionsMigrations);
  return db;
}

describe("edition store", () => {
  it("is empty and not legacy on a fresh database", () => {
    expect(readEditionState(freshDb())).toEqual({ mode: null, legacy: false, parked: [] });
  });

  it("never throws when the table does not exist", () => {
    expect(readEditionState(new Database(":memory:"))).toEqual({ mode: null, legacy: false, parked: [] });
    expect(readEditionMode(new Database(":memory:"))).toBeNull();
  });

  it("round-trips mode and parked", () => {
    const db = freshDb();
    writeEditionState(db, { mode: "business", parked: ["home", "leisure"] });
    expect(readEditionState(db)).toEqual({ mode: "business", legacy: false, parked: ["home", "leisure"] });
    writeEditionState(db, { parked: [] });
    expect(readEditionState(db).mode).toBe("business");
    expect(readEditionMode(db)).toBe("business");
  });

  it("marks an install that already had extensions as legacy", () => {
    const db = new Database(":memory:");
    // Versions 1–3 only: the state of a kernel from before this feature.
    runMigrations(db, "extensions", extensionsMigrations.filter((m) => m.version < 4));
    db.prepare(
      "INSERT INTO installed_extensions (id, slug, name, version, type, status, manifest_json, source_json, install_path, installed_at, updated_at) VALUES ('com.x','x','X','1.0.0','module','active','{}','{}','', '2026-01-01', '2026-01-01')",
    ).run();
    runMigrations(db, "extensions", extensionsMigrations);
    expect(readEditionState(db).legacy).toBe(true);
  });
});

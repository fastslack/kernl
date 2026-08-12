import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { GraphDriverRegistry } from "../src/core/db-drivers/graph-driver-registry.js";
import type { GraphDriver } from "../src/core/db-drivers/graph-driver.js";

/**
 * Seeding decides which graph driver a fresh install starts out on. Getting it
 * wrong is silent: the no-op driver reports `cypher: false`, every graph write
 * turns into a no-op, and the only symptom is a graph that stays empty.
 */

function stubDriver(name: string, selfConfigurable: boolean | undefined): GraphDriver {
  const driver = {
    name,
    kind: "graph" as const,
    deployment: "external-server" as const,
    capabilities: {
      cypher: false,
      gds: false,
      vectorSimilarity: false,
      mlPipelines: false,
      embedded: false,
      parameterised: false,
      transactions: false,
    },
    getConfigSchema: () => [],
    validateConfig: () => ({ valid: true }),
    configure: () => {},
    start: async () => {},
    stop: async () => {},
    isReady: () => false,
    getStatus: () => ({ slug: name, name, kind: "graph" as const, ready: false }),
  } as unknown as GraphDriver;
  if (selfConfigurable !== undefined) {
    (driver as { canSelfConfigure?: () => boolean }).canSelfConfigure = () => selfConfigurable;
  }
  return driver;
}

function statusOf(db: Database, slug: string): string | undefined {
  const row = db
    .prepare("SELECT status FROM installed_extensions WHERE slug = ?")
    .get(slug) as { status: string } | undefined;
  return row?.status;
}

describe("GraphDriverRegistry seeding", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db as never, "extensions", extensionsMigrations);
  });

  it("activates a self-configurable driver over one registered earlier", () => {
    const registry = new GraphDriverRegistry();
    registry.setDb(db as never);
    // "noop" registers first, exactly as it does at bootstrap.
    registry.registerFactory("noop", () => stubDriver("noop", undefined));
    registry.registerFactory("neo4j", () => stubDriver("neo4j", true));

    registry.seedBuiltinRows();

    expect(statusOf(db, "neo4j")).toBe("active");
    expect(statusOf(db, "noop")).toBe("installed");
  });

  it("falls back to registration order when nothing can self-configure", () => {
    const registry = new GraphDriverRegistry();
    registry.setDb(db as never);
    registry.registerFactory("noop", () => stubDriver("noop", undefined));
    registry.registerFactory("neo4j", () => stubDriver("neo4j", false));

    registry.seedBuiltinRows();

    expect(statusOf(db, "noop")).toBe("active");
    expect(statusOf(db, "neo4j")).toBe("installed");
  });

  it("never overrides a choice already recorded", () => {
    const first = new GraphDriverRegistry();
    first.setDb(db as never);
    first.registerFactory("noop", () => stubDriver("noop", undefined));
    first.registerFactory("neo4j", () => stubDriver("neo4j", false));
    first.seedBuiltinRows();
    expect(statusOf(db, "noop")).toBe("active");

    // Credentials appear later (a graph server is added to the stack). The
    // operator's existing selection still wins — seeding only fills gaps.
    const second = new GraphDriverRegistry();
    second.setDb(db as never);
    second.registerFactory("noop", () => stubDriver("noop", undefined));
    second.registerFactory("neo4j", () => stubDriver("neo4j", true));
    second.seedBuiltinRows();

    expect(statusOf(db, "noop")).toBe("active");
    expect(statusOf(db, "neo4j")).toBe("installed");
  });

  it("tolerates a factory that throws while probing", () => {
    const registry = new GraphDriverRegistry();
    registry.setDb(db as never);
    registry.registerFactory("broken", () => {
      throw new Error("factory blew up");
    });
    registry.registerFactory("neo4j", () => stubDriver("neo4j", true));

    expect(() => registry.seedBuiltinRows()).not.toThrow();
    expect(statusOf(db, "neo4j")).toBe("active");
  });
});

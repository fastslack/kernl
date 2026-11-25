// The first-run wizard runs once per install, not once per browser: the
// kernel answers whether setup is done, and a finished wizard records it.
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/sdk/migrations.js";
import { configMigrations } from "../src/modules/config/migrations/001_config.js";
import { registerSettingsRoutes } from "../src/modules/config/settings-routes.js";

type Handler = (req: { body?: unknown }) => unknown;
let db: Database;
let routes: Map<string, Handler>;

function mount() {
  routes = new Map();
  const server = { route: (method: string, path: string, h: Handler) => routes.set(`${method} ${path}`, h) };
  registerSettingsRoutes(server as never, {
    sqlite: db as never,
    config: {} as never,
    events: { emit() {}, on() {} } as never,
    extensionService: { list: () => [] } as never,
  });
}
const call = (key: string) => routes.get(key)!({}) as { complete: boolean };

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db as never, "config", configMigrations);
  mount();
});

describe("/api/setup", () => {
  it("is not complete on an empty kernel", () => {
    expect(call("GET /api/setup/state")).toEqual({ complete: false });
  });

  it("stays complete once the wizard says so", () => {
    expect(call("POST /api/setup/complete")).toEqual({ complete: true });
    expect(call("POST /api/setup/complete")).toEqual({ complete: true });
    expect(call("GET /api/setup/state")).toEqual({ complete: true });
  });

  it("counts an install that predates the flag as set up once an agent has run", () => {
    db.run("CREATE TABLE agent_runs (id TEXT PRIMARY KEY)");
    expect(call("GET /api/setup/state")).toEqual({ complete: false });
    db.run("INSERT INTO agent_runs (id) VALUES ('r1')");
    expect(call("GET /api/setup/state")).toEqual({ complete: true });
  });
});

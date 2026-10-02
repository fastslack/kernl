import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rehydrateStoredSettings } from "../src/core/bootstrap/stored-settings.js";
import type { KernelConfig } from "../src/core/config.js";

const KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SOME_SETTING"];
let saved: Record<string, string | undefined>;
let db: InstanceType<typeof Database>;

function config(): KernelConfig {
  return { google: { clientId: "", clientSecret: "", callbackPort: 8787 } } as unknown as KernelConfig;
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  db = new Database(":memory:");
  db.run("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
});

afterEach(() => {
  db.close();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("rehydrateStoredSettings", () => {
  it("brings Google OAuth credentials saved from the dashboard into the config at boot", () => {
    db.run("INSERT INTO app_settings VALUES ('GOOGLE_CLIENT_ID', 'id.apps.googleusercontent.com'), ('GOOGLE_CLIENT_SECRET', 'GOCSPX-x'), ('SOME_SETTING', 'v')");
    const cfg = config();
    const restored = rehydrateStoredSettings(db, cfg);
    expect(restored).toBe(3);
    expect(cfg.google.clientId).toBe("id.apps.googleusercontent.com");
    expect(cfg.google.clientSecret).toBe("GOCSPX-x");
    expect(process.env.SOME_SETTING).toBe("v");
  });

  it("lets a real environment variable win over the stored value", () => {
    process.env.GOOGLE_CLIENT_ID = "from-env";
    db.run("INSERT INTO app_settings VALUES ('GOOGLE_CLIENT_ID', 'stored')");
    const cfg = config();
    cfg.google.clientId = "from-env";
    rehydrateStoredSettings(db, cfg);
    expect(process.env.GOOGLE_CLIENT_ID).toBe("from-env");
    expect(cfg.google.clientId).toBe("from-env");
  });

  it("is a no-op on a fresh install where the settings table doesn't exist yet", () => {
    const empty = new Database(":memory:");
    expect(rehydrateStoredSettings(empty, config())).toBe(0);
    empty.close();
  });
});

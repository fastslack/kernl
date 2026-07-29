import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { googleSyncMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/001_google_sync.js";
import { authHealthMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/005_auth_health.js";
import { GoogleAuth } from "../assets/extensions/integration/google-sync/_module/auth.js";

function setup() {
  const db = new Database(":memory:");
  runMigrations(db, "google-sync", googleSyncMigrations);
  runMigrations(db, "google-sync-auth-health", authHealthMigrations);
  const auth = new GoogleAuth(db, "client-id", "client-secret", 9999);
  return { db, auth };
}

function insertToken(db: Database) {
  db.prepare(
    `INSERT INTO google_tokens (id, access_token, refresh_token, expires_at, scopes, updated_at)
     VALUES (1, 'at', 'rt', ?, 'scope', ?)`,
  ).run(new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString());
}

describe("GoogleAuth health state machine", () => {
  let db: Database;
  let auth: GoogleAuth;
  beforeEach(() => { ({ db, auth } = setup()); });
  afterEach(() => { db.close(); });

  it("is disconnected with no token", () => {
    expect(auth.getStatus()).toBe("disconnected");
    expect(auth.isAuthenticated()).toBe(false);
  });

  it("is connected when a healthy token exists", () => {
    insertToken(db);
    expect(auth.getStatus()).toBe("connected");
    expect(auth.isAuthenticated()).toBe(true);
  });

  it("flips to needs_reauth when marked, and reports the error", () => {
    insertToken(db);
    auth.markNeedsReauth("invalid_grant");
    expect(auth.getStatus()).toBe("needs_reauth");
    // still has a token row (not disconnected)
    expect(auth.isAuthenticated()).toBe(true);
    const row = db.prepare("SELECT needs_reauth_at, last_auth_error FROM google_tokens WHERE id = 1").get() as
      { needs_reauth_at: string | null; last_auth_error: string | null };
    expect(row.needs_reauth_at).toBeTruthy();
    expect(row.last_auth_error).toContain("invalid_grant");
  });

  it("clears the needs_reauth flag on clearReauth (re-auth/refresh success)", () => {
    insertToken(db);
    auth.markNeedsReauth("invalid_grant");
    expect(auth.getStatus()).toBe("needs_reauth");
    auth.clearReauth();
    expect(auth.getStatus()).toBe("connected");
    const row = db.prepare("SELECT needs_reauth_at FROM google_tokens WHERE id = 1").get() as
      { needs_reauth_at: string | null };
    expect(row.needs_reauth_at).toBeNull();
  });
});

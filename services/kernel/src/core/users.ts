import type { SqliteDb } from "./db/sqlite.js";
import { newId, isoNow } from "./helpers.js";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Constant-time compare of two hex strings (returns false on length mismatch). */
function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface User {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: "admin" | "user";
  active: boolean;
  created_at: string;
  updated_at: string;
}

const USERS_MIGRATION = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export class UserService {
  constructor(private db: SqliteDb) {
    this.db.exec(USERS_MIGRATION);
  }

  /**
   * Hash a password with scrypt (memory-hard KDF). Format: `scrypt:<salt>:<hash>`.
   * SHA-256 (the old scheme) is far too fast to resist offline brute-force on a
   * leaked DB; scrypt slows each guess by ~6 orders of magnitude.
   */
  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    return `scrypt:${salt}:${hash}`;
  }

  /** Verify password against stored hash. Supports legacy SHA-256 `salt:hash`. */
  verifyPassword(password: string, storedHash: string): boolean {
    if (storedHash.startsWith("scrypt:")) {
      const [, salt, hash] = storedHash.split(":");
      if (!salt || !hash) return false;
      return timingSafeEqualHex(scryptSync(password, salt, 64).toString("hex"), hash);
    }
    // Legacy SHA-256 (`salt:hash`) — verified for backward compatibility so
    // pre-existing users can still log in; authenticate() upgrades them.
    const [salt, hash] = storedHash.split(":");
    if (!salt || !hash) return false;
    return timingSafeEqualHex(createHash("sha256").update(salt + password).digest("hex"), hash);
  }

  /** Create a new user */
  create(username: string, password: string, displayName = "", role: "admin" | "user" = "user"): User {
    const id = newId();
    const now = isoNow();
    const hash = this.hashPassword(password);

    this.db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, username, displayName, hash, role, now, now);

    return { id, username, display_name: displayName, password_hash: hash, role, active: true, created_at: now, updated_at: now };
  }

  /** Find user by username */
  findByUsername(username: string): User | null {
    return this.db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(username) as User | null;
  }

  /** Find user by ID */
  findById(id: string): User | null {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | null;
  }

  /** Authenticate: returns user if credentials valid, null otherwise */
  authenticate(username: string, password: string): User | null {
    const user = this.findByUsername(username);
    if (!user) return null;
    if (!this.verifyPassword(password, user.password_hash)) return null;
    // Transparently upgrade legacy SHA-256 hashes to scrypt on successful login.
    if (!user.password_hash.startsWith("scrypt:")) {
      const upgraded = this.hashPassword(password);
      this.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(upgraded, isoNow(), user.id);
    }
    return user;
  }

  /** Count users */
  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c;
  }

  /** Create default admin user if no users exist */
  ensureDefaultAdmin(password: string): void {
    if (this.count() === 0) {
      this.create("admin", password, "Administrator", "admin");
    }
  }
}

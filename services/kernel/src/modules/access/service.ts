/**
 * Users and personal tokens.
 *
 * A user proves who they are with a token the super admin mints for them
 * (`kul_…`). The plaintext is shown once, at creation; only its SHA-256
 * hash is kept, so a copy of the database hands out no working credential.
 * A token stops working when it is revoked, when it expires, or when its
 * user is disabled or deleted.
 *
 * What a user may do is not decided here: `resolve()` only says who a token
 * belongs to, and the request authorizer (core/principal.ts) decides what
 * that user may reach.
 */

import { createHash, randomBytes } from "node:crypto";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { newId, isoNow } from "../../core/helpers.js";
import type { Principal } from "../../core/principal.js";
import { isGrantablePermission, parsePermission } from "../../core/permissions.js";
import type { Scope } from "../../core/scope.js";
import { RefIndex } from "./ref-index.js";

export const USER_TOKEN_PREFIX = "kul_";

export interface UserRow {
  id: string;
  name: string;
  email: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface TokenRow {
  id: string;
  user_id: string;
  label: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface UserScope {
  /** 'all' reaches every office; 'restricted' only what is listed. */
  mode: "all" | "restricted";
  offices: string[];
  agents: string[];
}

export interface RoleRow {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  permissions: string[];
  user_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Seeded on every start, so a new version can change what a built-in role
 * grants. They cannot be edited or deleted; copy one to make a variant.
 */
export const BUILTIN_ROLES: ReadonlyArray<{ id: string; name: string; description: string; permissions: string[] }> = [
  {
    id: "role-admin",
    name: "Admin",
    description: "Everything, system settings included. Only the super admin manages users.",
    permissions: ["*:*", "system:*"],
  },
  {
    id: "role-viewer",
    name: "Viewer",
    description: "Reads every feature; changes nothing. No system settings.",
    permissions: ["*:read"],
  },
  {
    id: "role-office-operator",
    name: "Office operator",
    description: "Works with offices and agents: sees them, edits them, runs them.",
    permissions: ["agents:*", "projects:read"],
  },
];

export class AccessError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Don't write `last_used_at` on every request: once a minute is plenty. */
const LAST_USED_WRITE_EVERY_MS = 60_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AccessService {
  private lastUsedWritten = new Map<string, number>();
  /** userId → permissions; dropped whenever a role or an assignment changes. */
  private permissionCache = new Map<string, string[]>();
  /** userId → scope (null: every office); dropped when the scope changes. */
  private scopeCache = new Map<string, Scope | null>();
  readonly refs: RefIndex;

  constructor(private db: SqliteDb, private now: () => Date = () => new Date()) {
    this.refs = new RefIndex(db, () => this.now().getTime());
    this.seedBuiltinRoles();
  }

  // ── Scopes ─────────────────────────────────────────────

  getScope(userId: string): UserScope {
    const row = this.db
      .prepare(`SELECT office_scope FROM users WHERE id = ? AND deleted_at IS NULL`)
      .get(userId) as { office_scope: "all" | "restricted" } | undefined;
    if (!row) throw new AccessError(404, "user not found");
    const refs = this.db
      .prepare(`SELECT kind, ref_id FROM user_scopes WHERE user_id = ? ORDER BY kind, ref_id`)
      .all(userId) as Array<{ kind: "office" | "agent"; ref_id: string }>;
    return {
      mode: row.office_scope,
      offices: refs.filter((r) => r.kind === "office").map((r) => r.ref_id),
      agents: refs.filter((r) => r.kind === "agent").map((r) => r.ref_id),
    };
  }

  /** Replaces the user's scope. Every id must name an existing office or agent. */
  setScope(userId: string, input: { mode?: string; offices?: unknown; agents?: unknown }): UserScope {
    const current = this.getScope(userId);
    const mode = input.mode ?? current.mode;
    if (mode !== "all" && mode !== "restricted") throw new AccessError(400, "mode must be 'all' or 'restricted'");
    const offices = input.offices !== undefined ? idList(input.offices, "offices") : current.offices;
    const agents = input.agents !== undefined ? idList(input.agents, "agents") : current.agents;
    this.refs.invalidate();
    for (const id of offices) if (!this.refs.isOffice(id)) throw new AccessError(400, `not an office: ${id}`);
    for (const id of agents) if (!this.refs.isAgent(id)) throw new AccessError(400, `not an agent: ${id}`);
    const at = isoNow();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE users SET office_scope = ?, updated_at = ? WHERE id = ?`).run(mode, at, userId);
      this.db.prepare(`DELETE FROM user_scopes WHERE user_id = ?`).run(userId);
      for (const id of offices) {
        this.db.prepare(`INSERT INTO user_scopes (user_id, kind, ref_id, created_at) VALUES (?, 'office', ?, ?)`).run(userId, id, at);
      }
      for (const id of agents) {
        this.db.prepare(`INSERT INTO user_scopes (user_id, kind, ref_id, created_at) VALUES (?, 'agent', ?, ?)`).run(userId, id, at);
      }
    });
    tx();
    this.scopeCache.delete(userId);
    return this.getScope(userId);
  }

  /** What core/scope.ts asks on every request a user makes: null means every office. */
  scopeForUser(userId: string): Scope | null {
    if (this.scopeCache.has(userId)) return this.scopeCache.get(userId)!;
    let scope: Scope | null;
    try {
      const s = this.getScope(userId);
      scope = s.mode === "all" ? null : { offices: new Set(s.offices), agents: new Set(s.agents) };
    } catch {
      // A user that vanished between resolving the token and here reaches nothing.
      scope = { offices: new Set(), agents: new Set() };
    }
    this.scopeCache.set(userId, scope);
    return scope;
  }

  // ── Roles ──────────────────────────────────────────────

  private seedBuiltinRoles(): void {
    const at = isoNow();
    const tx = this.db.transaction(() => {
      for (const r of BUILTIN_ROLES) {
        this.db
          .prepare(
            `INSERT INTO roles (id, name, description, builtin, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
               builtin = 1, deleted_at = NULL`,
          )
          .run(r.id, r.name, r.description, at, at);
        this.db.prepare(`DELETE FROM role_permissions WHERE role_id = ?`).run(r.id);
        for (const perm of r.permissions) {
          this.db.prepare(`INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)`).run(r.id, perm);
        }
      }
    });
    tx();
    this.permissionCache.clear();
  }

  listRoles(): RoleRow[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.name, r.description, r.builtin, r.created_at, r.updated_at,
                (SELECT COUNT(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id
                  WHERE ur.role_id = r.id AND u.deleted_at IS NULL) AS user_count
           FROM roles r WHERE r.deleted_at IS NULL
          ORDER BY r.builtin DESC, r.name COLLATE NOCASE`,
      )
      .all() as Array<Omit<RoleRow, "builtin" | "permissions"> & { builtin: number }>;
    return rows.map((r) => ({ ...r, builtin: r.builtin === 1, permissions: this.rolePermissions(r.id) }));
  }

  getRole(id: string): RoleRow | null {
    return this.listRoles().find((r) => r.id === id) ?? null;
  }

  createRole(input: { name: string; description?: string; permissions: string[] }): RoleRow {
    const name = input.name?.trim();
    if (!name) throw new AccessError(400, "name is required");
    const permissions = validatePermissions(input.permissions);
    this.assertRoleNameFree(name);
    const id = newId();
    const at = isoNow();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO roles (id, name, description, builtin, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`)
        .run(id, name, (input.description ?? "").trim(), at, at);
      for (const perm of permissions) {
        this.db.prepare(`INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)`).run(id, perm);
      }
    });
    tx();
    return this.getRole(id)!;
  }

  updateRole(id: string, patch: { name?: string; description?: string; permissions?: string[] }): RoleRow {
    const role = this.getRole(id);
    if (!role) throw new AccessError(404, "role not found");
    if (role.builtin) throw new AccessError(409, "built-in roles cannot be changed; create a new role instead");
    const name = patch.name !== undefined ? patch.name.trim() : role.name;
    if (!name) throw new AccessError(400, "name cannot be empty");
    if (name.toLowerCase() !== role.name.toLowerCase()) this.assertRoleNameFree(name, id);
    const permissions = patch.permissions !== undefined ? validatePermissions(patch.permissions) : null;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ?`)
        .run(name, patch.description !== undefined ? patch.description.trim() : role.description, isoNow(), id);
      if (permissions) {
        this.db.prepare(`DELETE FROM role_permissions WHERE role_id = ?`).run(id);
        for (const perm of permissions) {
          this.db.prepare(`INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)`).run(id, perm);
        }
      }
    });
    tx();
    this.permissionCache.clear();
    return this.getRole(id)!;
  }

  /** Soft delete; whoever held the role loses what it granted at once. */
  deleteRole(id: string): void {
    const role = this.getRole(id);
    if (!role) throw new AccessError(404, "role not found");
    if (role.builtin) throw new AccessError(409, "built-in roles cannot be deleted");
    const at = isoNow();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE roles SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(at, at, id);
      this.db.prepare(`DELETE FROM user_roles WHERE role_id = ?`).run(id);
    });
    tx();
    this.permissionCache.clear();
  }

  /** The roles a user holds (live roles only). */
  userRoleIds(userId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT ur.role_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id = ? AND r.deleted_at IS NULL ORDER BY r.name COLLATE NOCASE`,
        )
        .all(userId) as Array<{ role_id: string }>
    ).map((r) => r.role_id);
  }

  /** Replaces the user's roles with exactly these. */
  setUserRoles(userId: string, roleIds: string[]): string[] {
    if (!this.getUser(userId)) throw new AccessError(404, "user not found");
    const ids = [...new Set(roleIds)];
    for (const id of ids) {
      if (!this.getRole(id)) throw new AccessError(400, `unknown role: ${id}`);
    }
    const at = isoNow();
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).run(userId);
      for (const id of ids) {
        this.db.prepare(`INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)`).run(userId, id, at);
      }
    });
    tx();
    this.permissionCache.delete(userId);
    return this.userRoleIds(userId);
  }

  /** Union of what the user's roles grant. Asked on every request a user makes. */
  permissionsForUser(userId: string): string[] {
    const hit = this.permissionCache.get(userId);
    if (hit) return hit;
    const perms = (
      this.db
        .prepare(
          `SELECT DISTINCT rp.permission
             FROM user_roles ur
             JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
             JOIN role_permissions rp ON rp.role_id = r.id
            WHERE ur.user_id = ?
            ORDER BY rp.permission`,
        )
        .all(userId) as Array<{ permission: string }>
    ).map((r) => r.permission);
    this.permissionCache.set(userId, perms);
    return perms;
  }

  private rolePermissions(roleId: string): string[] {
    return (
      this.db
        .prepare(`SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission`)
        .all(roleId) as Array<{ permission: string }>
    ).map((r) => r.permission);
  }

  private assertRoleNameFree(name: string, exceptId?: string): void {
    const taken = this.db
      .prepare(`SELECT id FROM roles WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL`)
      .get(name) as { id: string } | undefined;
    if (taken && taken.id !== exceptId) throw new AccessError(409, "another role has that name");
  }

  // ── Users ──────────────────────────────────────────────

  listUsers(): UserRow[] {
    return this.db
      .prepare(
        `SELECT id, name, email, status, created_at, updated_at
           FROM users WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
      )
      .all() as UserRow[];
  }

  getUser(id: string): UserRow | null {
    return (
      (this.db
        .prepare(
          `SELECT id, name, email, status, created_at, updated_at
             FROM users WHERE id = ? AND deleted_at IS NULL`,
        )
        .get(id) as UserRow | undefined) ?? null
    );
  }

  createUser(input: { name: string; email?: string }): UserRow {
    const name = input.name?.trim();
    if (!name) throw new AccessError(400, "name is required");
    const email = normalizeEmail(input.email);
    this.assertEmailFree(email);
    const id = newId();
    const at = isoNow();
    this.db
      .prepare(
        `INSERT INTO users (id, name, email, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, name, email, at, at);
    return this.getUser(id)!;
  }

  updateUser(id: string, patch: { name?: string; email?: string; status?: string }): UserRow {
    const user = this.getUser(id);
    if (!user) throw new AccessError(404, "user not found");
    const name = patch.name !== undefined ? patch.name.trim() : user.name;
    if (!name) throw new AccessError(400, "name cannot be empty");
    const email = patch.email !== undefined ? normalizeEmail(patch.email) : user.email;
    if (email !== user.email) this.assertEmailFree(email, id);
    const status = patch.status ?? user.status;
    if (status !== "active" && status !== "disabled") throw new AccessError(400, "status must be 'active' or 'disabled'");
    this.db
      .prepare(`UPDATE users SET name = ?, email = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(name, email, status, isoNow(), id);
    return this.getUser(id)!;
  }

  /** Soft delete; every token the user held stops working at once. */
  deleteUser(id: string): void {
    if (!this.getUser(id)) throw new AccessError(404, "user not found");
    const at = isoNow();
    this.db.prepare(`UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(at, at, id);
    this.db.prepare(`UPDATE user_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(at, id);
    this.db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).run(id);
    this.db.prepare(`DELETE FROM user_scopes WHERE user_id = ?`).run(id);
    this.permissionCache.delete(id);
    this.scopeCache.delete(id);
  }

  // ── Tokens ─────────────────────────────────────────────

  listTokens(userId: string): TokenRow[] {
    return this.db
      .prepare(
        `SELECT id, user_id, label, prefix, created_at, last_used_at, expires_at, revoked_at
           FROM user_tokens WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId) as TokenRow[];
  }

  /** Mints a token. The plaintext is in the result and nowhere else, ever. */
  createToken(userId: string, input: { label?: string; expires_at?: string | null } = {}): { token: string; record: TokenRow } {
    if (!this.getUser(userId)) throw new AccessError(404, "user not found");
    let expiresAt: string | null = null;
    if (input.expires_at) {
      const t = Date.parse(input.expires_at);
      if (Number.isNaN(t)) throw new AccessError(400, "expires_at must be an ISO date");
      if (t <= this.now().getTime()) throw new AccessError(400, "expires_at must be in the future");
      expiresAt = new Date(t).toISOString();
    }
    const token = USER_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO user_tokens (id, user_id, label, token_hash, prefix, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, (input.label ?? "").trim(), hashToken(token), token.slice(0, USER_TOKEN_PREFIX.length + 6), isoNow(), expiresAt);
    const record = this.db
      .prepare(
        `SELECT id, user_id, label, prefix, created_at, last_used_at, expires_at, revoked_at
           FROM user_tokens WHERE id = ?`,
      )
      .get(id) as TokenRow;
    return { token, record };
  }

  revokeToken(tokenId: string): void {
    const r = this.db
      .prepare(`UPDATE user_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(isoNow(), tokenId);
    if (r.changes === 0) {
      const exists = this.db.prepare(`SELECT 1 FROM user_tokens WHERE id = ?`).get(tokenId);
      if (!exists) throw new AccessError(404, "token not found");
    }
  }

  // ── Resolution (called on every request with a non-kernel token) ──

  /** The user a token belongs to, or null if it opens nothing. */
  resolve(token: string): Principal | null {
    if (!token.startsWith(USER_TOKEN_PREFIX)) return null;
    const row = this.db
      .prepare(
        `SELECT t.id AS token_id, t.expires_at, u.id AS user_id, u.name
           FROM user_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ?
            AND t.revoked_at IS NULL
            AND u.deleted_at IS NULL
            AND u.status = 'active'`,
      )
      .get(hashToken(token)) as { token_id: string; expires_at: string | null; user_id: string; name: string } | undefined;
    if (!row) return null;
    const nowMs = this.now().getTime();
    if (row.expires_at && Date.parse(row.expires_at) <= nowMs) return null;
    this.touch(row.token_id, nowMs);
    return { kind: "user", id: row.user_id, name: row.name, tokenId: row.token_id };
  }

  /**
   * The user with this id while they may sign in (not deleted, active).
   * For a caller authenticated elsewhere (the broker, at its handshake),
   * so a user disabled since then is turned away on their next request.
   */
  resolveUser(id: string): Principal | null {
    const row = this.db
      .prepare(`SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL AND status = 'active'`)
      .get(id) as { id: string; name: string } | undefined;
    return row ? { kind: "user", id: row.id, name: row.name, tokenId: "" } : null;
  }

  private touch(tokenId: string, nowMs: number): void {
    const last = this.lastUsedWritten.get(tokenId) ?? 0;
    if (nowMs - last < LAST_USED_WRITE_EVERY_MS) return;
    this.lastUsedWritten.set(tokenId, nowMs);
    try {
      this.db.prepare(`UPDATE user_tokens SET last_used_at = ? WHERE id = ?`).run(new Date(nowMs).toISOString(), tokenId);
    } catch {
      // Bookkeeping only: a busy database must not turn a valid token away.
    }
  }

  private assertEmailFree(email: string, exceptId?: string): void {
    if (!email) return;
    const taken = this.db
      .prepare(`SELECT id FROM users WHERE email = ? AND deleted_at IS NULL`)
      .get(email) as { id: string } | undefined;
    if (taken && taken.id !== exceptId) throw new AccessError(409, "another user has that email");
  }
}

function idList(input: unknown, what: string): string[] {
  if (!Array.isArray(input) || input.some((v) => typeof v !== "string" || v === "")) {
    throw new AccessError(400, `${what} must be a list of ids`);
  }
  return [...new Set(input as string[])].sort();
}

function validatePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) throw new AccessError(400, "permissions must be a list");
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string" || !isGrantablePermission(raw)) {
      throw new AccessError(400, `not a permission a role can hold: ${String(raw)}`);
    }
    const p = parsePermission(raw)!;
    out.add(`${p.module}:${p.level}`);
  }
  return [...out].sort();
}

function normalizeEmail(email: string | undefined): string {
  const e = (email ?? "").trim().toLowerCase();
  if (e && !/^[^\s@]+@[^\s@]+$/.test(e)) throw new AccessError(400, "email is not valid");
  return e;
}

let current: AccessService | null = null;

export function setAccessService(svc: AccessService | null): void {
  current = svc;
}

export function getAccessService(): AccessService | null {
  return current;
}

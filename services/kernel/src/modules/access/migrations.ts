import type { Migration } from "../../core/db/migrations.js";

/**
 * Users and their personal tokens. The super admin is not here: it is the
 * kernel token (core/principal.ts), so it can never be deleted or disabled.
 *
 * A token is stored only as its SHA-256 hash; `prefix` keeps a few
 * characters so the owner can tell their tokens apart in a list.
 */
export const accessMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        email       TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
        ON users(email) WHERE email <> '' AND deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS user_tokens (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id),
        label         TEXT NOT NULL DEFAULT '',
        token_hash    TEXT NOT NULL UNIQUE,
        prefix        TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        last_used_at  TEXT,
        expires_at    TEXT,
        revoked_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id);
    `,
  },
  {
    // Roles: named sets of permissions (`tasks:read`, `agents:*`; see
    // core/permissions.ts). A user holds any number of roles and gets the
    // union of their permissions. Built-in roles are seeded by the service
    // and cannot be edited or deleted.
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS roles (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        builtin      INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        deleted_at   TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name
        ON roles(name COLLATE NOCASE) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id     TEXT NOT NULL REFERENCES roles(id),
        permission  TEXT NOT NULL,
        PRIMARY KEY (role_id, permission)
      );

      CREATE TABLE IF NOT EXISTS user_roles (
        user_id     TEXT NOT NULL REFERENCES users(id),
        role_id     TEXT NOT NULL REFERENCES roles(id),
        created_at  TEXT NOT NULL,
        PRIMARY KEY (user_id, role_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);
    `,
  },
  {
    // Scopes: which offices and agents a user reaches. `office_scope` 'all'
    // (the default) reaches every office; 'restricted' only the offices and
    // agents listed in user_scopes (core/scope.ts).
    version: 3,
    sql: `
      ALTER TABLE users ADD COLUMN office_scope TEXT NOT NULL DEFAULT 'all'
        CHECK(office_scope IN ('all','restricted'));

      CREATE TABLE IF NOT EXISTS user_scopes (
        user_id     TEXT NOT NULL REFERENCES users(id),
        kind        TEXT NOT NULL CHECK(kind IN ('office','agent')),
        ref_id      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (user_id, kind, ref_id)
      );
    `,
  },
  {
    // Projects join the scope (core/scope.ts). A CHECK cannot be altered in
    // SQLite, so the table is rebuilt with the grants it already holds.
    version: 4,
    sql: `
      CREATE TABLE user_scopes_v4 (
        user_id     TEXT NOT NULL REFERENCES users(id),
        kind        TEXT NOT NULL CHECK(kind IN ('office','agent','project')),
        ref_id      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (user_id, kind, ref_id)
      );
      INSERT INTO user_scopes_v4 (user_id, kind, ref_id, created_at)
        SELECT user_id, kind, ref_id, created_at FROM user_scopes;
      DROP TABLE user_scopes;
      ALTER TABLE user_scopes_v4 RENAME TO user_scopes;
    `,
  },
];

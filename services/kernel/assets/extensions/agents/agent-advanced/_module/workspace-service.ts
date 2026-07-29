/**
 * Workspace registry — each office can own multiple named workspaces,
 * optionally shared so other offices can read them.
 *
 * On-disk layout: data/workspaces/{workspace_id}/...
 *
 * For back-compat, legacy per-flow directories (created before this schema)
 * are auto-registered on startup as workspaces with id = flow_id, name = 'main'.
 */

import { readdirSync, existsSync } from "node:fs";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";
import { WORKSPACE_ROOT, DEFAULT_WORKSPACE_NAME } from "../../../../../src/modules/agents/workspace-constants.js";

export { WORKSPACE_ROOT, DEFAULT_WORKSPACE_NAME };

export interface Workspace {
  id: string;
  owner_flow_id: string;
  name: string;
  description: string;
  shared: number; // 0 or 1
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateWorkspaceInput {
  owner_flow_id: string;
  name: string;
  description?: string;
  shared?: boolean;
  /** Pre-chosen id (only used for back-compat registration of legacy dirs). */
  id?: string;
}

export type AccessMode = "read" | "write";

export class WorkspaceService {
  constructor(private db: SqliteDb) {}

  create(input: CreateWorkspaceInput): Workspace {
    const now = isoNow();
    const row: Workspace = {
      id: input.id ?? newId(),
      owner_flow_id: input.owner_flow_id,
      name: input.name,
      description: input.description ?? "",
      shared: input.shared ? 1 : 0,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO workspaces (id, owner_flow_id, name, description, shared, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.owner_flow_id, row.name, row.description, row.shared, row.created_at, row.updated_at);
    return row;
  }

  get(id: string): Workspace | undefined {
    return this.db
      .prepare("SELECT * FROM workspaces WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Workspace | undefined;
  }

  getByOwnerName(ownerFlowId: string, name: string): Workspace | undefined {
    return this.db
      .prepare("SELECT * FROM workspaces WHERE owner_flow_id = ? AND name = ? AND deleted_at IS NULL")
      .get(ownerFlowId, name) as Workspace | undefined;
  }

  listByOwner(ownerFlowId: string): Workspace[] {
    return this.db
      .prepare("SELECT * FROM workspaces WHERE owner_flow_id = ? AND deleted_at IS NULL ORDER BY name")
      .all(ownerFlowId) as Workspace[];
  }

  listShared(excludeOwner?: string): Workspace[] {
    if (excludeOwner) {
      return this.db
        .prepare("SELECT * FROM workspaces WHERE shared = 1 AND owner_flow_id <> ? AND deleted_at IS NULL ORDER BY updated_at DESC")
        .all(excludeOwner) as Workspace[];
    }
    return this.db
      .prepare("SELECT * FROM workspaces WHERE shared = 1 AND deleted_at IS NULL ORDER BY updated_at DESC")
      .all() as Workspace[];
  }

  listAll(): Workspace[] {
    return this.db
      .prepare("SELECT * FROM workspaces WHERE deleted_at IS NULL ORDER BY owner_flow_id, name")
      .all() as Workspace[];
  }

  update(id: string, patch: { name?: string; description?: string; shared?: boolean }): Workspace | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = {
      name: patch.name ?? cur.name,
      description: patch.description ?? cur.description,
      shared: patch.shared === undefined ? cur.shared : (patch.shared ? 1 : 0),
    };
    this.db
      .prepare("UPDATE workspaces SET name = ?, description = ?, shared = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.description, next.shared, isoNow(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    const res = this.db
      .prepare("UPDATE workspaces SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(isoNow(), id);
    return res.changes > 0;
  }

  touch(id: string): void {
    this.db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(isoNow(), id);
  }

  /**
   * Resolve a workspace reference from a caller's perspective. The caller can
   * pass either `workspace_id` (looked up directly) OR `workspace` (name — scoped
   * to the caller's own flow unless `workspace_owner_flow_id` is provided).
   * If nothing is passed, returns the caller's DEFAULT workspace (name='main'),
   * auto-creating it if it doesn't exist.
   *
   * Access check: read = owner OR shared=1; write = owner only.
   */
  resolveForCaller(opts: {
    callerFlowId: string;
    access: AccessMode;
    workspace_id?: string;
    workspace_name?: string;
    workspace_owner_flow_id?: string;
  }): { ok: true; workspace: Workspace } | { ok: false; error: string } {
    const { callerFlowId, access } = opts;
    if (!callerFlowId) return { ok: false, error: "No flow_id — agent is not assigned to an office" };

    let ws: Workspace | undefined;

    if (opts.workspace_id) {
      ws = this.get(opts.workspace_id);
      if (!ws) return { ok: false, error: `Workspace not found: ${opts.workspace_id}` };
    } else if (opts.workspace_name) {
      const ownerFlow = opts.workspace_owner_flow_id ?? callerFlowId;
      ws = this.getByOwnerName(ownerFlow, opts.workspace_name);
      if (!ws && ownerFlow === callerFlowId) {
        ws = this.create({ owner_flow_id: callerFlowId, name: opts.workspace_name });
      }
      if (!ws) return { ok: false, error: `Workspace not found: ${opts.workspace_name} (owner: ${ownerFlow})` };
    } else {
      ws = this.getByOwnerName(callerFlowId, DEFAULT_WORKSPACE_NAME);
      if (!ws) {
        ws = this.create({
          id: callerFlowId, // legacy path compat: default workspace gets the flow_id
          owner_flow_id: callerFlowId,
          name: DEFAULT_WORKSPACE_NAME,
          description: "Default workspace (auto-created)",
        });
      }
    }

    // Access check
    if (access === "write" && ws.owner_flow_id !== callerFlowId) {
      return { ok: false, error: `Write denied — workspace "${ws.name}" is owned by another office` };
    }
    if (access === "read" && ws.owner_flow_id !== callerFlowId && !ws.shared) {
      return { ok: false, error: `Read denied — workspace "${ws.name}" is private to another office` };
    }

    return { ok: true, workspace: ws };
  }

  /**
   * Scan the workspace root directory and register any legacy per-flow
   * directories as workspaces (id = flow_id, name = 'main'). Idempotent.
   */
  registerLegacyDirs(): number {
    if (!existsSync(WORKSPACE_ROOT)) return 0;
    let registered = 0;
    let entries: string[];
    try {
      entries = readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return 0;
    }

    for (const dirName of entries) {
      // Check across active + soft-deleted — a previously soft-deleted row
      // still holds the PK, so we'd otherwise fail with SQLITE_CONSTRAINT_PRIMARYKEY.
      const row = this.db
        .prepare("SELECT id, deleted_at FROM workspaces WHERE id = ?")
        .get(dirName) as { id: string; deleted_at: string | null } | undefined;
      if (row) {
        if (row.deleted_at) {
          // Resurrect.
          this.db
            .prepare("UPDATE workspaces SET deleted_at = NULL, updated_at = ? WHERE id = ?")
            .run(isoNow(), dirName);
          registered++;
        }
        continue;
      }
      this.create({
        id: dirName,
        owner_flow_id: dirName,
        name: DEFAULT_WORKSPACE_NAME,
        description: "Auto-registered from legacy directory",
      });
      registered++;
    }
    if (registered > 0) log.info(`Workspaces: registered ${registered} legacy director(ies) as 'main' workspaces`);
    return registered;
  }
}

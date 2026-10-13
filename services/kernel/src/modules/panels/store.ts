// src/modules/panels/store.ts
import type { SqliteDb } from "../../core/db/sqlite.js";
import { newId, isoNow } from "../../core/helpers.js";
import type { PanelSpec } from "./spec.js";

const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

export class PanelStore {
  constructor(private readonly db: SqliteDb) {}

  saveSpec(flowId: string, spec: PanelSpec, rootDir: string): void {
    this.db.prepare(
      `INSERT INTO office_panels (flow_id, spec_json, root_dir, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(flow_id) DO UPDATE SET spec_json = excluded.spec_json, root_dir = excluded.root_dir, updated_at = excluded.updated_at`,
    ).run(flowId, JSON.stringify(spec), rootDir, isoNow());
  }

  getSpec(flowId: string): { spec: PanelSpec; rootDir: string; updatedAt: string } | null {
    const r = this.db.prepare("SELECT spec_json, root_dir, updated_at FROM office_panels WHERE flow_id = ?").get(flowId) as
      { spec_json: string; root_dir: string; updated_at: string } | undefined;
    return r ? { spec: parse(r.spec_json) as PanelSpec, rootDir: r.root_dir, updatedAt: r.updated_at } : null;
  }

  listSpecs(): Array<{ flowId: string; spec: PanelSpec }> {
    const rows = this.db.prepare("SELECT flow_id, spec_json FROM office_panels ORDER BY flow_id").all() as Array<{ flow_id: string; spec_json: string }>;
    return rows.map((r) => ({ flowId: r.flow_id, spec: parse(r.spec_json) as PanelSpec }));
  }

  deleteSpec(flowId: string): void {
    this.db.prepare("DELETE FROM office_panels WHERE flow_id = ?").run(flowId);
  }

  putRecord(owner: string, collection: string, key: string, data: unknown, by: string): void {
    this.db.prepare(
      `INSERT INTO panel_records (owner, collection, key, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner, collection, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(owner, collection, key, JSON.stringify(data ?? null), isoNow(), by);
  }

  appendRecord(owner: string, collection: string, data: unknown, by: string): string {
    const key = `${isoNow()}-${newId().slice(0, 8)}`;
    this.putRecord(owner, collection, key, data, by);
    return key;
  }

  listRecords(owner: string, collection: string, limit = 200): Array<{ key: string; data: unknown; updated_at: string; updated_by: string }> {
    const rows = this.db.prepare(
      `SELECT key, data, updated_at, updated_by FROM panel_records WHERE owner = ? AND collection = ?
       ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
    ).all(owner, collection, Math.max(1, Math.min(limit, 1000))) as Array<{ key: string; data: string; updated_at: string; updated_by: string }>;
    return rows.map((r) => ({ ...r, data: parse(r.data) }));
  }

  collectionVersion(owner: string, collection: string): string {
    const r = this.db.prepare(
      "SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS last FROM panel_records WHERE owner = ? AND collection = ?",
    ).get(owner, collection) as { n: number; last: string };
    return `${r.n}-${r.last}`;
  }

  audit(e: { owner: string; action: string; values: unknown; ok: boolean; result: string; actor: string }): void {
    this.db.prepare(
      "INSERT INTO panel_audit (id, owner, action, values_json, ok, result, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(newId(), e.owner, e.action, JSON.stringify(e.values ?? {}), e.ok ? 1 : 0, e.result.slice(0, 2000), e.actor, isoNow());
  }

  listAudit(owner: string, limit = 50): Array<{ action: string; values: unknown; ok: boolean; result: string; actor: string; at: string }> {
    const rows = this.db.prepare(
      "SELECT action, values_json, ok, result, actor, at FROM panel_audit WHERE owner = ? ORDER BY at DESC, rowid DESC LIMIT ?",
    ).all(owner, Math.max(1, Math.min(limit, 500))) as Array<{ action: string; values_json: string; ok: number; result: string; actor: string; at: string }>;
    return rows.map((r) => ({ action: r.action, values: parse(r.values_json), ok: r.ok === 1, result: r.result, actor: r.actor, at: r.at }));
  }
}

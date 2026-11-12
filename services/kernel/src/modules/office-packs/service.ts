/**
 * Export an office's knowledge as a pack, and bring a pack into an office
 * through review (pack.ts has the format).
 *
 * Export takes each agent's active learnings above a confidence floor and, by
 * default, blanks emails, phone numbers, tokens and home paths. Import never
 * writes a learning: it stages the lessons, matched to the office's agents by
 * name and checked against what they already know. `review` accepts or rejects
 * them; an accepted lesson becomes an ordinary learning, with its confidence
 * capped so a stranger's certainty does not outrank what the office learned
 * itself.
 */
import { createHash } from "node:crypto";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { newId, isoNow } from "../../core/helpers.js";
import { PACK_FORMAT, PACK_VERSION, lessonKey, parsePack, redact, toJson, toMarkdown, type LearningType, type Pack } from "./pack.js";

export type AddLearning = (input: { agent_id: string; type: LearningType; content: string; confidence: number; source_runs: string[]; project_id: null }) => { id: string };

/** The most an imported lesson starts with. */
export const IMPORTED_CONFIDENCE_CAP = 0.6;

interface OfficeRow { id: string; name: string; description: string }
interface AgentRow { id: string; name: string; role: string }

export interface PackItem {
  id: string;
  agent_name: string;
  agent_id: string;
  type: LearningType;
  content: string;
  confidence: number;
  status: "pending" | "accepted" | "rejected" | "duplicate" | "no_agent";
}

export class OfficePackService {
  constructor(private db: SqliteDb, private addLearning: () => AddLearning | null) {}

  office(idOrName: string): OfficeRow | null {
    return (this.db.prepare("SELECT id, name, description FROM agent_flows WHERE id = ? OR lower(name) = lower(?) LIMIT 1").get(idOrName, idOrName) as OfficeRow | undefined) ?? null;
  }

  private agents(officeId: string): AgentRow[] {
    return this.db.prepare("SELECT id, name, role FROM agents WHERE flow_id = ? ORDER BY name").all(officeId) as AgentRow[];
  }

  export(officeId: string, opts: { format?: "json" | "markdown"; minConfidence?: number; redact?: boolean; now?: string } = {}) {
    const office = this.office(officeId);
    if (!office) throw new Error(`Office not found: ${officeId}`);
    const floor = opts.minConfidence ?? 0.5;
    const clean = opts.redact === false ? (s: string) => s : redact;
    let lessons = 0;
    const agents = this.agents(office.id).map((a) => {
      // Craft learnings only: a project's lessons belong to that project, not to the office's know-how.
      const rows = this.db.prepare(
        `SELECT type, content, confidence FROM agent_learnings
         WHERE agent_id = ? AND active = 1 AND confidence >= ? AND project_id IS NULL`,
      ).all(a.id, floor) as Array<{ type: LearningType; content: string; confidence: number }>;
      const seen = new Set<string>();
      const learnings = rows
        .map((r) => ({ type: r.type, content: clean(r.content).replace(/\s+/g, " ").trim(), confidence: Math.round(r.confidence * 100) / 100 }))
        .filter((r) => {
          const k = `${r.type}:${lessonKey(r.content)}`;
          if (!r.content || seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      lessons += learnings.length;
      return { name: a.name, role: a.role, learnings };
    }).filter((a) => a.learnings.length > 0);
    const pack: Pack = {
      format: PACK_FORMAT, version: PACK_VERSION, name: office.name, description: clean(office.description),
      exported_at: opts.now ?? isoNow(), agents,
    };
    const content = opts.format === "markdown" ? toMarkdown(pack) : toJson(pack);
    return { office: office.name, agents: agents.length, lessons, format: opts.format ?? "json", content };
  }

  /** Stage a pack's lessons for review. Importing the same pack twice into an office stages it once. */
  import(officeId: string, text: string, opts: { source?: string; agentMap?: Record<string, string> } = {}) {
    const office = this.office(officeId);
    if (!office) throw new Error(`Office not found: ${officeId}`);
    const pack = parsePack(text);
    const hash = createHash("sha256").update(toJson({ ...pack, exported_at: "" })).digest("hex");
    const again = this.db.prepare("SELECT id FROM office_pack_imports WHERE office_id = ? AND pack_hash = ?").get(office.id, hash) as { id: string } | undefined;
    if (again) return { import_id: again.id, already: true, ...this.summary(again.id) };

    const agents = this.agents(office.id);
    const byName = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
    const byRole = new Map<string, AgentRow[]>();
    for (const a of agents) byRole.set(a.role.toLowerCase(), [...(byRole.get(a.role.toLowerCase()) ?? []), a]);
    const pick = (name: string, role: string): AgentRow | undefined => {
      const mapped = opts.agentMap?.[name];
      if (mapped) return agents.find((a) => a.id === mapped || a.name.toLowerCase() === mapped.toLowerCase());
      // By name; or, when the office has exactly one agent in that role, by role.
      return byName.get(name.toLowerCase()) ?? (role && byRole.get(role.toLowerCase())?.length === 1 ? byRole.get(role.toLowerCase())![0] : undefined);
    };

    const id = newId();
    const now = isoNow();
    const insert = this.db.prepare(
      `INSERT INTO office_pack_items (id, import_id, agent_name, agent_id, type, content, confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO office_pack_imports (id, office_id, pack_name, pack_hash, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, office.id, pack.name, hash, opts.source ?? "", now);
      const known = new Map<string, Set<string>>();
      for (const a of pack.agents) {
        const target = pick(a.name, a.role);
        let have = target ? known.get(target.id) : undefined;
        if (target && !have) {
          have = new Set((this.db.prepare("SELECT content FROM agent_learnings WHERE agent_id = ? AND active = 1").all(target.id) as Array<{ content: string }>).map((r) => lessonKey(r.content)));
          known.set(target.id, have);
        }
        for (const l of a.learnings) {
          const k = lessonKey(l.content);
          const status = !target ? "no_agent" : have!.has(k) ? "duplicate" : "pending";
          if (status === "pending") have!.add(k);
          insert.run(newId(), id, a.name, target?.id ?? "", l.type, l.content, l.confidence, status);
        }
      }
    })();
    return { import_id: id, already: false, ...this.summary(id) };
  }

  summary(importId: string) {
    const counts = Object.fromEntries(
      (this.db.prepare("SELECT status, COUNT(*) AS n FROM office_pack_items WHERE import_id = ? GROUP BY status").all(importId) as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]),
    );
    const unmatched = (this.db.prepare("SELECT DISTINCT agent_name FROM office_pack_items WHERE import_id = ? AND status = 'no_agent'").all(importId) as Array<{ agent_name: string }>).map((r) => r.agent_name);
    return { counts, unmatched_agents: unmatched };
  }

  items(importId: string, status?: PackItem["status"]): PackItem[] {
    return this.db.prepare(
      `SELECT id, agent_name, agent_id, type, content, confidence, status FROM office_pack_items
       WHERE import_id = ? ${status ? "AND status = ?" : ""} ORDER BY agent_name, type, confidence DESC`,
    ).all(...(status ? [importId, status] : [importId])) as PackItem[];
  }

  imports(officeId?: string) {
    return this.db.prepare(
      `SELECT i.id, i.office_id, f.name AS office, i.pack_name, i.source, i.created_at,
              SUM(CASE WHEN it.status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN it.status = 'accepted' THEN 1 ELSE 0 END) AS accepted
       FROM office_pack_imports i LEFT JOIN agent_flows f ON f.id = i.office_id
       LEFT JOIN office_pack_items it ON it.import_id = i.id
       ${officeId ? "WHERE i.office_id = ?" : ""} GROUP BY i.id ORDER BY i.created_at DESC`,
    ).all(...(officeId ? [officeId] : [])) as Array<Record<string, unknown>>;
  }

  /** Accept and/or reject pending lessons ("all" for every pending one). */
  review(importId: string, opts: { accept?: string[] | "all"; reject?: string[] | "all" }) {
    const add = this.addLearning();
    if (!add) throw new Error("Agents are not available.");
    const pending = new Map(this.items(importId, "pending").map((i) => [i.id, i]));
    const pickIds = (sel: string[] | "all" | undefined) => (sel === "all" ? [...pending.keys()] : (sel ?? []).filter((x) => pending.has(x)));
    const accept = pickIds(opts.accept);
    const reject = pickIds(opts.reject).filter((x) => !accept.includes(x));
    const now = isoNow();
    const accepted: Array<{ item: string; learning: string }> = [];
    for (const itemId of accept) {
      const it = pending.get(itemId)!;
      const l = add({
        agent_id: it.agent_id, type: it.type, content: it.content,
        confidence: Math.min(it.confidence, IMPORTED_CONFIDENCE_CAP), source_runs: [`pack:${importId}`], project_id: null,
      });
      this.db.prepare("UPDATE office_pack_items SET status = 'accepted', learning_id = ?, reviewed_at = ? WHERE id = ?").run(l.id, now, itemId);
      accepted.push({ item: itemId, learning: l.id });
    }
    for (const itemId of reject) {
      this.db.prepare("UPDATE office_pack_items SET status = 'rejected', reviewed_at = ? WHERE id = ?").run(now, itemId);
    }
    const unknown = [...(opts.accept === "all" ? [] : opts.accept ?? []), ...(opts.reject === "all" ? [] : opts.reject ?? [])].filter((x) => !pending.has(x));
    return { accepted, rejected: reject.length, not_pending: unknown, ...this.summary(importId) };
  }
}

/**
 * The letter types an office's orchestrator reads, and what each must carry.
 *
 * An office whose orchestrator is code reads letters by type: the subject
 * starts with the type (`E2E-DEV-ROJO web#2873`) and the body carries a
 * ```json block with the fields the orchestrator acts on. A letter missing one
 * was only caught after it was sent: the orchestrator answered «carta
 * inválida» and the agent had to be woken again to resend it (15/11, an
 * E2E-DEV-ROJO with no "veredicto"). With the types registered here, the
 * letter is refused when the agent posts it, and the agent fixes it in the
 * same run.
 */
import type { SqliteDb } from "../../core/db/sqlite.js";
import { isoNow } from "../../core/helpers.js";

export interface LetterSchema {
  /** The subject's first word, e.g. `E2E-DEV-ROJO`. */
  type: string;
  /** Fields the JSON block must carry, non-empty. */
  required: string[];
  /** Fields that must hold exactly this value (compared as text, case-insensitive). */
  equals?: Record<string, string>;
  /** A body that passes, shown to the agent when its letter is refused. */
  example?: string;
  description?: string;
}

/** The subject's type: its first word. */
export function letterTypeOf(subject: string): string {
  return subject.trim().split(/[\s:]+/, 1)[0] ?? "";
}

/** Every JSON object in a body: each ```json block, or the whole body when it is one. */
export function jsonObjectsIn(body: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s.trim());
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch { /* not JSON */ }
  };
  for (const m of body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) tryParse(m[1]);
  if (out.length === 0 && body.trim().startsWith("{")) tryParse(body);
  return out;
}

const filled = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");

/** Why the letter does not meet its type's schema, or null when it does (or its type has no schema). */
export function letterProblem(schemas: LetterSchema[], subject: string, body: string): string | null {
  const type = letterTypeOf(subject);
  const schema = schemas.find((s) => s.type === type);
  if (!schema) return null;
  const objects = jsonObjectsIn(body);
  const missing = (o: Record<string, unknown>) => [
    ...schema.required.filter((k) => !filled(o[k])).map((k) => `"${k}"`),
    ...Object.entries(schema.equals ?? {})
      .filter(([k, v]) => String(o[k] ?? "").trim().toLowerCase() !== v.trim().toLowerCase())
      .map(([k, v]) => `"${k}": "${v}"`),
  ];
  if (objects.some((o) => missing(o).length === 0)) return null;
  const best = objects.map(missing).sort((a, b) => a.length - b.length)[0];
  const what = objects.length === 0
    ? "it has no ```json block"
    : `its \`\`\`json block lacks ${best.join(", ")}`;
  return `A ${type} letter must carry a \`\`\`json block with ${[...schema.required.map((k) => `"${k}"`),
    ...Object.entries(schema.equals ?? {}).map(([k, v]) => `"${k}": "${v}"`)].join(", ")}; ${what}. ` +
    `Not sent: post it again with the same subject` + (schema.example ? `, for example:\n\`\`\`json\n${schema.example}\n\`\`\`` : ".");
}

/** Parse what an API client sent as an office's schemas; throws on anything malformed. */
export function parseLetterSchemas(raw: unknown): LetterSchema[] {
  if (!Array.isArray(raw)) throw new Error("schemas must be a list");
  return raw.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const type = String(o.type ?? "").trim();
    if (!/^[A-Z][A-Z0-9_-]{1,40}$/.test(type)) throw new Error(`schemas[${i}].type must be an upper-case word like E2E-DEV-ROJO`);
    const required = Array.isArray(o.required) ? o.required.map((k) => String(k).trim()).filter(Boolean) : [];
    const equals = o.equals && typeof o.equals === "object" && !Array.isArray(o.equals)
      ? Object.fromEntries(Object.entries(o.equals as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;
    if (required.length === 0 && !equals) throw new Error(`schemas[${i}] needs required fields or equals`);
    return {
      type, required, ...(equals ? { equals } : {}),
      ...(typeof o.example === "string" && o.example.trim() ? { example: o.example.trim() } : {}),
      ...(typeof o.description === "string" && o.description.trim() ? { description: o.description.trim() } : {}),
    };
  });
}

export class LetterSchemasService {
  constructor(private readonly db: SqliteDb) {}

  list(flowId: string): LetterSchema[] {
    return (this.db.prepare("SELECT schema FROM agent_letter_schemas WHERE flow_id=? ORDER BY type").all(flowId) as Array<{ schema: string }>)
      .map((r) => JSON.parse(r.schema) as LetterSchema);
  }

  /** Replace an office's schemas with these. */
  replace(flowId: string, schemas: LetterSchema[]): void {
    const at = isoNow();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_letter_schemas WHERE flow_id=?").run(flowId);
      const ins = this.db.prepare("INSERT INTO agent_letter_schemas (flow_id, type, schema, updated_at) VALUES (?, ?, ?, ?)");
      for (const s of schemas) ins.run(flowId, s.type, JSON.stringify(s), at);
    })();
  }
}

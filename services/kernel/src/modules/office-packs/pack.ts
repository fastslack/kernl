/**
 * The knowledge pack format: what an office learned, as a file a person can
 * read, diff in git and review before another Kernl takes it in.
 *
 * Two spellings of the same thing, both importable:
 *   - JSON  — { format: "kernl-office-pack", version: 1, office, agents: [{ name, learnings }] }
 *   - Markdown — a front block, then `## <agent>` and one `- [type 0.80] lesson` line each.
 *
 * Output is deterministic (agents and lessons sorted, no per-item times), so
 * exporting twice gives the same file and a git diff shows only what changed.
 */

export const PACK_FORMAT = "kernl-office-pack";
export const PACK_VERSION = 1;
export const LEARNING_TYPES = ["pattern", "avoid", "prefer", "insight"] as const;
export type LearningType = (typeof LEARNING_TYPES)[number];

export interface PackLearning {
  type: LearningType;
  content: string;
  confidence: number;
}

export interface Pack {
  format: typeof PACK_FORMAT;
  version: number;
  name: string;
  description: string;
  exported_at: string;
  agents: Array<{ name: string; role: string; learnings: PackLearning[] }>;
}

export const MAX_LESSON_CHARS = 1000;
export const MAX_PACK_ITEMS = 2000;

/** Personal details and secrets that should not leave in a shared file. */
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abps]|glpat)[-_][A-Za-z0-9_-]{12,}\b/g, "[secret]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, "Bearer [secret]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[hex]"],
  [/\/(?:Users|home)\/[^/\s]+/g, "~"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, by] of REDACTIONS) out = out.replace(re, by);
  // Phone numbers: 9+ digits with the usual separators — not dates, versions or times.
  return out.replace(/(?<![\w.:])\+?\d[\d\s().-]{7,}\d(?![\w.:])/g, (m) =>
    (m.match(/\d/g) ?? []).length >= 9 && !/^\d{4}-\d{2}-\d{2}/.test(m.trim()) ? "[phone]" : m,
  );
}

/** One line, no control characters, bounded. */
export function cleanLesson(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LESSON_CHARS);
}

/** For "is this the same lesson": case, spacing and punctuation do not count. */
export function lessonKey(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const round2 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;

export function sortPack(p: Pack): Pack {
  const agents = p.agents
    .map((a) => ({
      ...a,
      learnings: [...a.learnings].sort(
        (x, y) => LEARNING_TYPES.indexOf(x.type) - LEARNING_TYPES.indexOf(y.type) || y.confidence - x.confidence || x.content.localeCompare(y.content),
      ),
    }))
    .sort((x, y) => x.name.localeCompare(y.name));
  return { ...p, agents };
}

export function toJson(p: Pack): string {
  return JSON.stringify(sortPack(p), null, 2) + "\n";
}

export function toMarkdown(p: Pack): string {
  const s = sortPack(p);
  const lines = [
    "---",
    `format: ${PACK_FORMAT}`,
    `version: ${s.version}`,
    `name: ${oneLine(s.name)}`,
    `exported_at: ${s.exported_at}`,
    "---",
    "",
    `# ${oneLine(s.name)}`,
    "",
  ];
  if (s.description) lines.push(oneLine(s.description), "");
  for (const a of s.agents) {
    lines.push(`## ${oneLine(a.name)}`);
    if (a.role) lines.push(`role: ${oneLine(a.role)}`);
    lines.push("");
    for (const l of a.learnings) lines.push(`- [${l.type} ${l.confidence.toFixed(2)}] ${oneLine(l.content)}`);
    lines.push("");
  }
  return lines.join("\n");
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Read either spelling. Throws with a message a person can act on. */
export function parsePack(text: string): Pack {
  const t = text.replace(/^﻿/, "").trim();
  if (!t) throw new Error("The pack is empty.");
  const raw = t.startsWith("{") ? parseJson(t) : parseMarkdown(t);
  return validate(raw);
}

function parseJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new Error(`The pack is not valid JSON: ${(e as Error).message}`);
  }
}

function parseMarkdown(t: string): unknown {
  const front = t.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!front) throw new Error("A Markdown pack starts with a --- block that says `format: kernl-office-pack`.");
  const meta: Record<string, string> = {};
  for (const l of front[1].split("\n")) {
    const m = l.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  const agents: Array<{ name: string; role: string; learnings: unknown[] }> = [];
  let description = "";
  let cur: (typeof agents)[number] | null = null;
  const body = t.slice(front[0].length).split("\n");
  for (const line of body) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      cur = { name: h[1].trim(), role: "", learnings: [] };
      agents.push(cur);
      continue;
    }
    if (!cur) {
      if (line.trim() && !line.startsWith("# ")) description = description ? `${description} ${line.trim()}` : line.trim();
      continue;
    }
    const role = line.match(/^role:\s*(.*)$/);
    if (role) {
      cur.role = role[1].trim();
      continue;
    }
    const item = line.match(/^[-*]\s+\[(\w+)(?:\s+([\d.]+))?\]\s+(.+)$/);
    if (item) cur.learnings.push({ type: item[1].toLowerCase(), confidence: item[2] ? Number(item[2]) : 0.5, content: item[3] });
  }
  return { format: meta.format, version: Number(meta.version), name: meta.name ?? "", description, exported_at: meta.exported_at ?? "", agents };
}

function validate(raw: unknown): Pack {
  const r = raw as Partial<Pack> & { agents?: unknown };
  if (!r || typeof r !== "object" || r.format !== PACK_FORMAT) throw new Error(`Not a knowledge pack (format must be "${PACK_FORMAT}").`);
  if (r.version !== PACK_VERSION) throw new Error(`Pack version ${String(r.version)} is not supported (this Kernl reads version ${PACK_VERSION}).`);
  if (!Array.isArray(r.agents)) throw new Error("The pack has no agents list.");
  let count = 0;
  const agents: Pack["agents"] = [];
  for (const a of r.agents as Array<Record<string, unknown>>) {
    const name = cleanLesson(String(a?.name ?? "")).slice(0, 120);
    if (!name) continue;
    const learnings: PackLearning[] = [];
    for (const l of (Array.isArray(a.learnings) ? a.learnings : []) as Array<Record<string, unknown>>) {
      const type = String(l?.type ?? "").toLowerCase();
      const content = cleanLesson(String(l?.content ?? ""));
      if (!content || !(LEARNING_TYPES as readonly string[]).includes(type)) continue;
      const c = Number(l.confidence);
      learnings.push({ type: type as LearningType, content, confidence: round2(Number.isFinite(c) ? c : 0.5) });
      if (++count > MAX_PACK_ITEMS) throw new Error(`The pack has more than ${MAX_PACK_ITEMS} lessons.`);
    }
    agents.push({ name, role: cleanLesson(String(a.role ?? "")).slice(0, 60), learnings });
  }
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    name: cleanLesson(String(r.name ?? "")).slice(0, 200),
    description: cleanLesson(String(r.description ?? "")),
    exported_at: String(r.exported_at ?? ""),
    agents,
  };
}

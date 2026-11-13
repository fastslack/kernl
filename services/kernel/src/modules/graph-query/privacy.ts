/**
 * What an outside MCP client (Claude Code, another app) may see of the graph.
 *
 * Kernl's own agents read the whole graph, under their own tool permissions.
 * A client connected over MCP is a different trust level: the graph holds
 * mail, chat memory and facts about people. So for clients:
 *
 *   GRAPH_MCP_ACCESS   off | schema | read   (default read)
 *   GRAPH_PRIVATE_LABELS  labels a client never sees (default below; "none" for none)
 *
 * With `read`, a client's query must not name a private label, and every node
 * pattern must carry a label (or reuse a variable that has one) — otherwise
 * `(p:Person)--(x)` would walk straight into an Email. Rows are checked again
 * on the way out: a private node that slips through comes back as a stub.
 */
import { blankLiterals } from "./gate.js";

export type GraphAccess = "off" | "schema" | "read";

export const DEFAULT_PRIVATE_LABELS = ["Email", "EmailThread", "Memory", "Fact", "ChatMessage", "AgentMemory"];

export interface ClientPolicy {
  access: GraphAccess;
  privateLabels: Set<string>;
}

export function clientPolicy(env: Record<string, string | undefined> = process.env): ClientPolicy {
  const a = (env.GRAPH_MCP_ACCESS ?? "").trim().toLowerCase();
  const access: GraphAccess = a === "off" || a === "schema" || a === "read" ? a : "read";
  const raw = env.GRAPH_PRIVATE_LABELS?.trim();
  const labels = raw === undefined || raw === "" ? DEFAULT_PRIVATE_LABELS : raw.toLowerCase() === "none" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
  return { access, privateLabels: new Set(labels) };
}

/** Why a client may not run this query, or null. Run after the read-only gate. */
export function clientGate(cypher: string, policy: ClientPolicy): string | null {
  if (policy.access !== "read") return "This MCP client may not query the graph (GRAPH_MCP_ACCESS).";
  const text = blankLiterals(cypher);
  if (/:\s*\$/.test(text)) return "Dynamic labels are not available to MCP clients.";

  // Labels and relationship types named anywhere: `:Email`, `:Email|Person`, `:\`Email\``.
  for (const m of text.matchAll(/:\s*((?:`[^`]+`|[A-Za-z_]\w*)(?:\s*[|&:]\s*!?(?:`[^`]+`|[A-Za-z_]\w*))*)/g)) {
    for (const name of m[1].split(/[|&:!\s]+/).map((s) => s.replace(/`/g, "")).filter(Boolean)) {
      if (policy.privateLabels.has(name)) return `:${name} is private to Kernl's own agents.`;
    }
  }

  if (policy.privateLabels.size === 0) return null;
  // Every node pattern needs a label, directly or through its variable.
  const labeled = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.])\(\s*([A-Za-z_]\w*)\s*:/g)) labeled.add(m[1]);
  for (const m of text.matchAll(/(?<![\w.$])\(\s*([A-Za-z_]\w*)?\s*(\{[^}]*\})?\s*\)/g)) {
    const before = text.slice(Math.max(0, m.index! - 6), m.index!);
    if (/CALL\s*$/i.test(before)) continue; // CALL (n) { … }: imports a variable, not a pattern
    const v = m[1];
    if (!v) return "Every node in a pattern needs a label for MCP clients: write (x:Label), not ().";
    if (!labeled.has(v) && !isPlainExpression(text, m.index!, m[0])) {
      return `Give (${v}) a label, e.g. (${v}:Person): MCP clients may only reach labeled nodes.`;
    }
  }
  return null;
}

/** `(x)` that is an expression, not a node: `RETURN (x)`, `WHERE (x)` with no relationship next to it. */
function isPlainExpression(text: string, at: number, match: string): boolean {
  const before = text.slice(0, at).trimEnd();
  const after = text.slice(at + match.length).trimStart();
  const nearRel = /[-<>]$/.test(before) || /^[-<>]/.test(after);
  if (nearRel) return false;
  return !/\b(MATCH|MERGE|CREATE)\s*$/i.test(before) && !/,\s*$/.test(before);
}

/** Schema as a client may see it. */
export function filterSchema<S extends { labels: Array<{ label: string }>; relationships: Array<{ from: string; to: string }>; indexes: Array<{ labels?: string[] }> }>(
  s: S,
  policy: ClientPolicy,
): S {
  const hide = (l: string) => policy.privateLabels.has(l);
  return {
    ...s,
    labels: s.labels.filter((l) => !hide(l.label)),
    relationships: s.relationships.filter((r) => !hide(r.from) && !hide(r.to)),
    indexes: s.indexes
      .map((i) => (i.labels ? { ...i, labels: i.labels.filter((l) => !hide(l)) } : i))
      .filter((i) => !i.labels || i.labels.length > 0),
  };
}

/** Rows with any private node replaced by a stub, at any depth. */
export function redactRows(rows: Array<Record<string, unknown>>, policy: ClientPolicy): { rows: Array<Record<string, unknown>>; redacted: number } {
  let redacted = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (!v || typeof v !== "object" || depth > 8) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const labels = (o._labels ?? o.labels) as unknown;
    if (Array.isArray(labels) && labels.some((l) => policy.privateLabels.has(String(l)))) {
      redacted++;
      return { _private: true };
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = walk(x, depth + 1);
    return out;
  };
  return { rows: rows.map((r) => walk(r, 0) as Record<string, unknown>), redacted };
}

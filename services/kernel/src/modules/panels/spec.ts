// src/modules/panels/spec.ts
/**
 * panels.v1 — what an office may declare: sources, views, anchors, actions.
 * Validated when the office is applied; nothing undeclared is ever served or run.
 */
import { z } from "zod";
import type { LiteSchema } from "./jsonschema-lite.js";
import type { Template } from "./template.js";

const ID = z.string().regex(/^[a-z][a-z0-9_.-]{0,47}$/, "ids are lowercase letters, digits, . _ -");
const Text = z.union([z.string().min(1).max(160), z.object({ es: z.string().max(160).optional(), en: z.string().max(160).optional() })
  .refine((o) => Boolean(o.es || o.en), "needs es or en")]);
const Tpl = z.union([z.string().max(4000), z.object({ by: z.string().min(1), cases: z.record(z.string().max(4000)) })]);
const Lite: z.ZodType<LiteSchema> = z.lazy(() => z.object({
  type: z.enum(["object", "array", "string", "number", "integer", "boolean"]).optional(),
  properties: z.record(Lite).optional(),
  required: z.array(z.string()).optional(),
  items: Lite.optional(),
  enum: z.array(z.unknown()).optional(),
  pattern: z.string().max(400).refine((p) => { try { new RegExp(p); return true; } catch { return false; } }, "pattern is not a valid regular expression").optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  maxLength: z.number().int().positive().optional(),
  title: Text.optional(),
  visibleIf: z.record(z.unknown()).optional(),
  secret: z.boolean().optional(),
}).strict());

const SafeRelPath = z.string().min(1).max(200).refine(
  (p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."),
  "state-file path must stay inside the office folder",
);

const Source = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state-file"), path: SafeRelPath, schema: Lite.optional() }).strict(),
  z.object({ type: z.literal("collection"), name: ID, schema: Lite.optional() }).strict(),
  // A module's dashboard channel (the same read-only snapshot /api/dashboard/<name> serves),
  // with fixed string params the office declares — e.g. which project.
  z.object({
    type: z.literal("channel"),
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, "channel names are letters, digits, . _ -"),
    params: z.record(z.string().max(200)).refine((o) => Object.keys(o).length <= 10, "at most 10 params").optional(),
    schema: Lite.optional(),
  }).strict(),
]);

const DataRef = z.string().regex(/^[a-z][a-z0-9_.-]{0,47}:\$/, 'data is "<source>:$<selector>"');

const View = z.object({
  id: ID,
  title: Text,
  icon: z.string().max(32).optional(),
  component: z.enum(["table", "board", "detail", "form", "timeline"]),
  data: DataRef.optional(),
  join: z.record(z.string().max(64)).optional(),
  columns: z.string().max(64).optional(),
  // Board only: "<source>:$<selector>" to a { column: total } map, for sources that send a capped list.
  counts: DataRef.optional(),
  order: z.array(z.string().max(64)).max(40).optional(),
  // `sub`: a second, quieter line under the field's value (e.g. "cardiólogo · Rosario" under the name).
  fields: z.array(z.object({ key: z.string().max(64), label: Text.optional(), sub: z.string().max(64).optional() }).strict()).max(30).optional(),
  card: z.object({
    title: z.string().max(400),
    subtitle: z.string().max(400).optional(),
    badges: z.array(z.string().max(64)).max(8).optional(),
    links: z.array(z.object({ label: Text, href: z.string().max(400) }).strict()).max(6).optional(),
  }).strict().optional(),
  detail: ID.optional(),
  sections: z.array(z.string().max(64)).max(20).optional(),
  actions: z.array(ID).max(12).optional(),
  action: ID.optional(),
  time: z.string().max(64).optional(),
  text: z.string().max(400).optional(),
}).strict();

const ActionBase = { label: Text, input: Lite.optional(), confirm: Text.optional() };
const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("letter"), to: z.string().max(80), subject: Tpl, body: Tpl.optional(), ...ActionBase }).strict(),
  z.object({ type: z.literal("run"), agent: z.string().max(80), goal: Tpl, ...ActionBase }).strict(),
  z.object({ type: z.literal("record"), collection: ID, key: z.string().max(200), ...ActionBase }).strict(),
  z.object({ type: z.literal("schedule"), agent: z.string().max(80), state: z.enum(["on", "off"]), ...ActionBase }).strict(),
]);

export const PanelSpecSchema = z.object({
  version: z.literal(1),
  sources: z.record(Source).refine((o) => Object.keys(o).every((k) => /^[a-z][a-z0-9_.-]{0,47}$/.test(k)), "bad source id"),
  views: z.array(View).min(1).max(20),
  anchors: z.array(z.object({ object: z.string().max(64), view: ID }).strict()).max(20).optional(),
  actions: z.record(Action).optional(),
}).strict();

export type PanelSpec = z.infer<typeof PanelSpecSchema>;
export type PanelSource = PanelSpec["sources"][string];
export type PanelView = PanelSpec["views"][number];
export type PanelAction = NonNullable<PanelSpec["actions"]>[string];

function caseFieldsOf(t: Template | undefined): string[] {
  return t && typeof t === "object" ? [t.by] : [];
}

export function parsePanelSpec(raw: unknown, ctx: { agentSlugs: string[] }):
  { ok: true; spec: PanelSpec } | { ok: false; error: string } {
  const parsed = PanelSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "(panels)"}: ${i.message}`).join("; ") };
  }
  const spec = parsed.data;
  const sources = new Set(Object.keys(spec.sources));
  const views = new Set(spec.views.map((v) => v.id));
  const actions = new Set(Object.keys(spec.actions ?? {}));
  const agents = new Set(ctx.agentSlugs);
  const errs: string[] = [];
  for (const v of spec.views) {
    const src = v.data?.split(":")[0];
    if (src && !sources.has(src)) errs.push(`view "${v.id}": unknown source "${src}"`);
    for (const j of Object.keys(v.join ?? {})) if (!sources.has(j)) errs.push(`view "${v.id}": unknown source "${j}" in join`);
    const countsSrc = v.counts?.split(":")[0];
    if (countsSrc && !sources.has(countsSrc)) errs.push(`view "${v.id}": unknown source "${countsSrc}" in counts`);
    if (v.counts && v.component !== "board") errs.push(`view "${v.id}": counts is only for a board`);
    if (v.detail && !views.has(v.detail)) errs.push(`view "${v.id}": unknown view "${v.detail}"`);
    for (const a of [...(v.actions ?? []), ...(v.action ? [v.action] : [])]) {
      if (!actions.has(a)) errs.push(`view "${v.id}": unknown action "${a}"`);
    }
    if (v.component === "form" && !v.action) errs.push(`view "${v.id}": a form needs "action"`);
    if (v.component !== "form" && !v.data) errs.push(`view "${v.id}": needs "data"`);
  }
  for (const a of spec.anchors ?? []) if (!views.has(a.view)) errs.push(`anchor "${a.object}": unknown view "${a.view}"`);
  for (const [id, a] of Object.entries(spec.actions ?? {})) {
    const target = a.type === "letter" ? a.to : a.type === "run" || a.type === "schedule" ? a.agent : null;
    if (target !== null && !agents.has(target)) errs.push(`action "${id}": agent "${target}" is not in this office`);
    const fields = new Set(Object.keys(a.input?.properties ?? {}));
    const templates = a.type === "letter" ? [a.subject, a.body] : a.type === "run" ? [a.goal] : [];
    for (const f of templates.flatMap((t) => caseFieldsOf(t as Template | undefined))) {
      if (!fields.has(f)) errs.push(`action "${id}": "${f}" is not an input field`);
    }
  }
  return errs.length ? { ok: false, error: errs.join("; ") } : { ok: true, spec };
}

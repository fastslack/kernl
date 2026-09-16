/**
 * The cards of the "Nueva oficina" gallery: three built-in templates and one
 * card per office an extension ships (installed or only in the catalog).
 * Names and summaries follow the operator's language; prompts stay in English
 * because they are read by the model, not by the operator.
 */
import type { KernelLanguage } from "../../core/config.js";
import type { FlowKind } from "./types.js";
import { defaultOfficeColor, type OfficeDefinition } from "./office-kit.js";

export interface OfficeTemplateAgent { name: string; role: "manager" | "worker"; summary: string }
export interface OfficeEntitlement { required_feature: string; licensed: boolean }

export interface OfficeTemplate {
  id: string;
  source: "builtin" | "extension";
  name: string;
  description: string;
  kind: FlowKind;
  color: string;
  agents: OfficeTemplateAgent[];
  definition?: OfficeDefinition;
  extension?: { slug: string; installed: boolean; enabled: boolean; entitlement: OfficeEntitlement | null };
}

export interface ExtensionOfficeSource {
  slug: string;
  name: string;
  description: string;
  installed: boolean;
  enabled: boolean;
  entitlement: OfficeEntitlement | null;
}

export interface OfficeTemplatesResponse { templates: OfficeTemplate[]; host_allowed: boolean }

type L10n = Record<KernelLanguage, string>;
const pick = (text: L10n, language: KernelLanguage): string => text[language];

const TECH_LEAD_PROMPT =
  "You are the office Tech Lead. Every run: read BACKLOG.md, pick ONE pending item, dispatch it to the Builder (kernel_agents_run), then to QA, and only tick the item off if QA passes. One item per run, then stop.";
const BUILDER_PROMPT =
  "You are the Builder. You implement exactly the item the Tech Lead hands you, against real files, using your native tools (Read/Write/Edit/Bash). Read before you write, make the smallest change that satisfies the item, and run the local build/typecheck.";
const QA_PROMPT =
  "You are QA. You verify the Builder's work: run build/typecheck/tests and review the diff (read-only). First line of your reply: PASS or FAIL, then the evidence. You never edit files.";
const CURATOR_PROMPT =
  "You are the office Curator. You decide what to research, dispatch the Researcher (kernel_agents_run), and consolidate their findings into one short, actionable note (kernel_notes_create).";
const RESEARCHER_PROMPT =
  "You are the Researcher. You search with the kernel tools (rss, research, webintel), verify sources, and return concrete findings with links. No filler: if there is no signal, say so.";

const MANAGER_TOOLS = ["kernel_agents_run", "kernel_agents_list", "kernel_notes_create"];

export function builtinTemplates(language: KernelLanguage): OfficeTemplate[] {
  const lead = pick({ es: "Tech Lead", en: "Tech Lead" }, language);
  const builder = pick({ es: "Builder", en: "Builder" }, language);
  const qa = pick({ es: "QA", en: "QA" }, language);
  const curator = pick({ es: "Curador", en: "Curator" }, language);
  const researcher = pick({ es: "Investigador", en: "Researcher" }, language);

  return [
    {
      id: "builtin:blank",
      source: "builtin",
      name: pick({ es: "En blanco", en: "Blank" }, language),
      description: pick({ es: "Una sala vacía. Sumás los agentes vos.", en: "An empty room. You add the agents." }, language),
      kind: "general",
      color: "#2563eb",
      agents: [],
      definition: { name: "", kind: "general", agents: [] },
    },
    {
      id: "builtin:builder",
      source: "builtin",
      name: pick({ es: "Constructora", en: "Builder" }, language),
      description: pick({ es: "Planifica, construye y prueba sobre un repo.", en: "Plans, builds and tests on a repo." }, language),
      kind: "devops",
      color: "#16a34a",
      agents: [
        { name: lead, role: "manager", summary: pick({ es: "Elige una tarea y la reparte", en: "Picks one task and hands it out" }, language) },
        { name: builder, role: "worker", summary: pick({ es: "Implementa la tarea", en: "Implements the task" }, language) },
        { name: qa, role: "worker", summary: pick({ es: "Verifica y responde PASS o FAIL", en: "Verifies and answers PASS or FAIL" }, language) },
      ],
      definition: {
        name: "",
        kind: "devops",
        agents: [
          { slug: "", name: lead, role: "manager", prompt: TECH_LEAD_PROMPT, tools: MANAGER_TOOLS, chainTo: [] },
          { slug: "", name: builder, role: "worker", prompt: BUILDER_PROMPT },
          { slug: "", name: qa, role: "worker", prompt: QA_PROMPT },
        ],
      },
    },
    {
      id: "builtin:research",
      source: "builtin",
      name: pick({ es: "Research", en: "Research" }, language),
      description: pick({ es: "Investiga un tema y te deja informes con fuentes.", en: "Researches a topic and leaves you sourced reports." }, language),
      kind: "general",
      color: "#7c3aed",
      agents: [
        { name: curator, role: "manager", summary: pick({ es: "Decide qué investigar y resume", en: "Decides what to research and sums up" }, language) },
        { name: researcher, role: "worker", summary: pick({ es: "Busca y verifica fuentes", en: "Searches and verifies sources" }, language) },
      ],
      definition: {
        name: "",
        kind: "general",
        agents: [
          { slug: "", name: curator, role: "manager", prompt: CURATOR_PROMPT, tools: MANAGER_TOOLS, chainTo: [] },
          { slug: "", name: researcher, role: "worker", prompt: RESEARCHER_PROMPT },
        ],
      },
    },
  ];
}

export function officeSourcesFrom(
  installed: Array<{ slug: string; name: string; status: string; manifest_json: string }>,
  catalog: Array<{ slug: string; feature?: string; manifest?: { name?: string; description?: string; office?: string } }>,
  hasLicense: (feature: string) => boolean,
): ExtensionOfficeSource[] {
  const out: ExtensionOfficeSource[] = [];
  const seen = new Set<string>();

  for (const row of installed) {
    let manifest: { office?: string; description?: string; pricing?: { model?: string } };
    try {
      manifest = JSON.parse(row.manifest_json) as typeof manifest;
    } catch {
      continue;
    }
    if (!manifest.office) continue;
    const paid = manifest.pricing != null && manifest.pricing.model !== "free";
    const feature = `pro:${row.slug}`;
    out.push({
      slug: row.slug,
      name: row.name,
      description: manifest.description ?? "",
      installed: true,
      enabled: row.status === "active",
      entitlement: paid ? { required_feature: feature, licensed: hasLicense(feature) } : null,
    });
    seen.add(row.slug);
  }

  for (const item of catalog) {
    if (!item.manifest?.office || seen.has(item.slug)) continue;
    out.push({
      slug: item.slug,
      name: item.manifest.name ?? item.slug,
      description: item.manifest.description ?? "",
      installed: false,
      enabled: false,
      entitlement: item.feature ? { required_feature: item.feature, licensed: hasLicense(item.feature) } : null,
    });
    seen.add(item.slug);
  }

  return out;
}

export function buildOfficeTemplates(
  language: KernelLanguage,
  sources: ExtensionOfficeSource[],
  hostAllowed: boolean,
): OfficeTemplatesResponse {
  const seen = new Set<string>();
  const fromExtensions: OfficeTemplate[] = [];
  for (const s of sources) {
    if (seen.has(s.slug)) continue;
    seen.add(s.slug);
    fromExtensions.push({
      id: `ext:${s.slug}`,
      source: "extension",
      name: s.name,
      description: s.description,
      kind: "general",
      color: defaultOfficeColor(s.name),
      agents: [],
      extension: { slug: s.slug, installed: s.installed, enabled: s.enabled, entitlement: s.entitlement },
    });
  }
  return { templates: [...builtinTemplates(language), ...fromExtensions], host_allowed: hostAllowed };
}

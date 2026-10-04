import { z } from "zod";
import type { ProjectBrief } from "./types.js";

export const ProjectBriefSchema = z.object({
  value_prop: z.string().trim().min(1, "value_prop is required"),
  audience: z.string().trim().min(1, "audience is required"),
  markets: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  voice: z.string().optional(),
  pricing: z.string().optional(),
  competitors: z.array(z.string()).optional(),
  links: z.record(z.string()).optional(),
});

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Slugs that would collide with fixed routes under /api/projects/ (the webhook). */
export const RESERVED_SLUGS = new Set(["webhook"]);

export function parseBrief(input: unknown): ProjectBrief {
  const r = ProjectBriefSchema.safeParse(input);
  if (!r.success) throw new Error(`Invalid brief: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

export function renderBriefMarkdown(name: string, b: ProjectBrief): string {
  const list = (xs?: string[]) => (xs && xs.length ? xs.join(", ") : "—");
  const links = Object.entries(b.links ?? {}).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "—";
  return [
    `# ${name} — Brief`,
    ``,
    `## Propuesta de valor`, b.value_prop, ``,
    `## Público`, b.audience, ``,
    `## Mercados`, list(b.markets), ``,
    `## Idiomas`, list(b.languages), ``,
    `## Tono de voz`, b.voice || "—", ``,
    `## Precios`, b.pricing || "—", ``,
    `## Competidores`, list(b.competitors), ``,
    `## Links`, links, ``,
  ].join("\n");
}

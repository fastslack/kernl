import { join } from "node:path";
import type { ProjectsService } from "./projects-service.js";

/**
 * The block every run for a project gets in its system prompt. One builder
 * for both executors (native + Claude Code) so they can never drift.
 */
export function buildProjectContext(svc: ProjectsService, flowId: string, projectId: string): { block: string; homeDir: string } {
  const p = svc.get(projectId);
  if (!p) throw new Error(`Project not found: ${projectId}`);
  const homeDir = svc.homeDir(p);
  const b = p.brief;
  const settings = svc.officeSettings(flowId, p.id);
  const links = svc.links(p.id);
  const lines = [
    `## Proyecto: ${p.name}`,
    `You are working for the project **${p.name}** (slug \`${p.slug}\`). Everything you produce in this run is for this project only.`,
    ``,
    `- Value proposition: ${b.value_prop}`,
    `- Audience: ${b.audience}`,
    ...(b.markets?.length ? [`- Markets: ${b.markets.join(", ")}`] : []),
    ...(b.languages?.length ? [`- Languages: ${b.languages.join(", ")}`] : []),
    ...(b.voice ? [`- Voice: ${b.voice}`] : []),
    ...(b.pricing ? [`- Pricing: ${b.pricing}`] : []),
    ...(b.competitors?.length ? [`- Competitors: ${b.competitors.join(", ")}`] : []),
    ``,
    `Office settings for this project: ${JSON.stringify(settings)}`,
    ``,
    `Project files (read before acting, append durable facts to MEMORY.md):`,
    `- ${join(homeDir, "BRIEF.md")}`,
    `- ${join(homeDir, "MEMORY.md")}`,
    `- ${join(homeDir, "assets")}/`,
    ``,
    links.length
      ? `Linked resources: ${links.map((l) => `${l.kind}=${l.ref_id}`).join(", ")}. Use only these accounts for this project.`
      : `No accounts are linked to this project yet.`,
    ``,
    `Anything that leaves Kernl (posts, emails, messages) must go through kernel_outbox_propose as a draft. You cannot publish or send directly while working for a project.`,
  ];
  return { block: lines.join("\n"), homeDir };
}

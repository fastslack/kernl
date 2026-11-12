/**
 * office-packs module — an office's knowledge as a file, and a reviewed way in.
 *
 *   * `kernel_office_pack_export` — the office's lessons as JSON or Markdown
 *     (sorted, redacted), to keep in git or hand to another Kernl.
 *   * `kernel_office_pack_import` — stage a pack's lessons for review; nothing
 *     reaches an agent yet.
 *   * `kernel_office_pack_review` — list staged lessons, accept or reject them.
 */
import { z } from "zod";
import type { KernelModule, ModuleContext, ToolDefinition, ToolResult } from "../../core/types.js";
import { errorResult, structuredResult } from "../../core/helpers.js";
import { runMigrations } from "../../core/db/migrations.js";
import { defineTool } from "../../core/tool-builder.js";
import { officePackMigrations } from "./migrations.js";
import { OfficePackService, IMPORTED_CONFIDENCE_CAP, type AddLearning } from "./service.js";

const cost = { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 20, reversible: true, cacheable: false };
const fail = (e: unknown) => errorResult(e instanceof Error ? e.message : String(e));

export function createOfficePacksModule(addLearning: () => AddLearning | null): KernelModule {
  let service: OfficePackService | null = null;

  const tools: ToolDefinition[] = [
    defineTool({
      name: "kernel_office_pack_export",
      description:
        "Export what an office's agents learned (their active, general learnings above a confidence floor) as a knowledge pack: " +
        "JSON or Markdown, sorted so exporting again gives a clean git diff. Emails, phone numbers, tokens and home paths are blanked " +
        "unless redact=false. Returns the file's content.",
      schema: z.object({
        office: z.string().min(1).describe("Office id or name."),
        format: z.enum(["json", "markdown"]).default("markdown"),
        min_confidence: z.number().min(0).max(1).default(0.5),
        redact: z.boolean().default(true),
      }),
      outputSchema: z.unknown(),
      tags: ["office", "knowledge"],
      cost,
      async handler(a): Promise<ToolResult> {
        if (!service) return errorResult("office packs not available");
        try {
          const r = service.export(a.office, { format: a.format, minConfidence: a.min_confidence, redact: a.redact });
          return structuredResult(r, `${r.lessons} lesson(s) from ${r.agents} agent(s) of ${r.office}:\n\n${r.content}`);
        } catch (e) {
          return fail(e);
        }
      },
    }),
    defineTool({
      name: "kernel_office_pack_import",
      description:
        "Bring a knowledge pack (the JSON or Markdown that kernel_office_pack_export makes) into an office, for review. " +
        "Lessons are matched to the office's agents by name (or by role when one agent has it; `agent_map` overrides), " +
        "compared with what they already know, and staged — none reaches an agent until accepted with kernel_office_pack_review. " +
        `Accepted lessons start at confidence ${IMPORTED_CONFIDENCE_CAP} at most.`,
      schema: z.object({
        office: z.string().min(1).describe("Office id or name."),
        pack: z.string().min(1).describe("The pack's content."),
        source: z.string().optional().describe("Where it came from, for the record (a repo, a person)."),
        agent_map: z.record(z.string(), z.string()).optional().describe("Pack agent name → this office's agent id or name."),
      }),
      outputSchema: z.unknown(),
      tags: ["office", "knowledge"],
      cost,
      async handler(a): Promise<ToolResult> {
        if (!service) return errorResult("office packs not available");
        try {
          const r = service.import(a.office, a.pack, { source: a.source, agentMap: a.agent_map });
          return structuredResult({ ...r, pending: service.items(r.import_id, "pending") });
        } catch (e) {
          return fail(e);
        }
      },
    }),
    defineTool({
      name: "kernel_office_pack_review",
      description:
        "Review staged pack lessons. With only `import_id` it lists them; `accept` and `reject` take item ids or \"all\" (every pending one). " +
        "Without `import_id` it lists the imports, with how many lessons still wait. Accepting makes the lesson an ordinary learning of its agent.",
      schema: z.object({
        import_id: z.string().optional(),
        office: z.string().optional().describe("Office id or name, to list only its imports."),
        accept: z.union([z.literal("all"), z.array(z.string())]).optional(),
        reject: z.union([z.literal("all"), z.array(z.string())]).optional(),
      }),
      outputSchema: z.unknown(),
      tags: ["office", "knowledge"],
      cost,
      async handler(a): Promise<ToolResult> {
        if (!service) return errorResult("office packs not available");
        try {
          if (!a.import_id) {
            const office = a.office ? service.office(a.office) : null;
            if (a.office && !office) return errorResult(`Office not found: ${a.office}`);
            return structuredResult({ imports: service.imports(office?.id) });
          }
          if (!a.accept && !a.reject) return structuredResult({ ...service.summary(a.import_id), items: service.items(a.import_id) });
          return structuredResult(service.review(a.import_id, { accept: a.accept, reject: a.reject }));
        } catch (e) {
          return fail(e);
        }
      },
    }),
  ];

  return {
    name: "office-packs",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "office-packs", officePackMigrations);
      service = new OfficePackService(ctx.sqlite, addLearning);
    },
    getTools(): ToolDefinition[] {
      return tools;
    },
    async shutdown() {
      service = null;
    },
  };
}

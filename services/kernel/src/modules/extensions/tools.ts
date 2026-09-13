import { z } from "zod";
import type { ToolDefinition } from "../../core/types.js";
import type { ExtensionService } from "./service.js";
import { defineTool } from "../../core/tool-builder.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function extensionsTools(service: ExtensionService): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_extensions_list",
      description:
        "List installed extensions, optionally filtering by type or status.",
      schema: z.object({
        type: z
          .enum(["module", "skill", "agent-bundle", "office", "flow", "theme", "template", "channel", "sandbox-driver", "suite"])
          .optional(),
        status: z.enum(["installed", "active", "disabled", "error"]).optional(),
      }),
      handler: async (input) => {
        const rows = service.list({ type: input.type, status: input.status });
        if (!rows.length) return text("No extensions match the filter.");
        const lines = rows.map(
          (r) =>
            `- **${r.name}** \`${r.slug}\` v${r.version} (${r.type}, ${r.status})`,
        );
        return text(`### Installed extensions (${rows.length})\n${lines.join("\n")}`);
      },
    }),
    defineTool({
      name: "kernel_extensions_install_bundle",
      description: "Install an extension from a local .kernl bundle path.",
      schema: z.object({
        bundle_path: z.string().min(1),
      }),
      handler: async (input) => {
        const row = await service.installFromBundle(input.bundle_path, {
          type: "file",
          filename: input.bundle_path,
        });
        return text(
          `Installed **${row.name}** v${row.version} (${row.type}) → ${row.install_path}`,
        );
      },
    }),
    defineTool({
      name: "kernel_extensions_update",
      description: "Upgrade an installed extension in place from a local .kernl bundle path.",
      schema: z.object({
        bundle_path: z.string().min(1),
        force: z.boolean().optional(),
      }),
      sideEffects: ["extension.updated:1"],
      handler: async (input) => {
        const r = await service.update(
          input.bundle_path,
          { type: "local", path: input.bundle_path },
          { force: input.force },
        );
        // A module's code is imported once per process — there is no hot
        // reload — so its new version runs from the next start. Skills, agents
        // and the other declarative types are applied by the update itself.
        const when = r.extension.type === "module"
          ? "The new code runs the next time Kernl starts — restart it now from Settings → About, or POST /api/update/restart."
          : "Active now.";
        return text(`✅ Updated ${r.extension.slug}: ${r.from} → ${r.to}. ${when}`);
      },
    }),
    defineTool({
      name: "kernel_extensions_enable",
      description: "Enable an installed extension by id.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async (input) => {
        await service.enable(input.id);
        return text(`Enabled ${input.id}`);
      },
    }),
    defineTool({
      name: "kernel_extensions_disable",
      description: "Disable an installed extension by id.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async (input) => {
        await service.disable(input.id);
        return text(`Disabled ${input.id}`);
      },
    }),
    defineTool({
      name: "kernel_extensions_uninstall",
      description: "Remove an extension (deletes files + row).",
      schema: z.object({ id: z.string().min(1) }),
      handler: async (input) => {
        await service.uninstall(input.id);
        return text(`Uninstalled ${input.id}`);
      },
    }),
    defineTool({
      name: "kernel_extensions_activate",
      description:
        "Activate an installed-but-idle extension (those with manifest.requires_activation=true). " +
        "Equivalent to enable() for that subset — exists as a separate tool so the consent step is auditable.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async (input) => {
        const row = service.get(input.id) ?? service.getBySlug(input.id);
        if (!row) return text(`Not installed: ${input.id}`);
        await service.enable(row.id);
        return text(`Activated **${row.name}** (${row.type}) — tools/services online.`);
      },
    }),
    defineTool({
      name: "kernel_extensions_receipt",
      description:
        "Get the install receipt for an extension — proves WHO installed it WHEN and from WHERE, " +
        "with the kernel's Ed25519 signature. Includes a download watermark when fetched from a " +
        "watermarking marketplace provider.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async (input) => {
        const row = service.get(input.id) ?? service.getBySlug(input.id);
        if (!row) return text(`Not installed: ${input.id}`);
        const receipt = service.getReceipt(row.id);
        if (!receipt) return text(`No receipt recorded for ${row.slug} (legacy install).`);
        return text("```json\n" + JSON.stringify(receipt, null, 2) + "\n```");
      },
    }),
  ];
}

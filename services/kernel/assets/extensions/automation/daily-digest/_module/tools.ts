import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { textResult } from "../../../../../src/core/helpers.js";
import { buildEveningDigest, buildMorningDigest } from "./digest-service.js";
import type { DigestKind } from "./scheduler.js";

export function digestTools(opts: {
  db: SqliteDb;
  sendNow: (kind: DigestKind) => Promise<Record<string, boolean>>;
}): ToolDefinition[] {
  const build = (kind: DigestKind) =>
    kind === "evening" ? buildEveningDigest(opts.db, new Date()) : buildMorningDigest(opts.db, new Date());

  return [
    {
      name: "kernel_digest_preview",
      description:
        "Preview a daily digest without sending it. kind=evening → tomorrow's tasks/events/reminders; kind=morning → today's agenda + overdue.",
      inputSchema: z.object({
        kind: z.enum(["evening", "morning"]).optional().describe("Which digest (default: evening)"),
      }),
      handler: async (args) => {
        const kind = (args as { kind?: DigestKind }).kind ?? "evening";
        return textResult(build(kind).markdown);
      },
    },
    {
      name: "kernel_digest_send_now",
      description:
        "Build and immediately deliver a digest to the configured channels (Telegram/WhatsApp) plus the dashboard. kind=evening (tomorrow) or morning (today).",
      inputSchema: z.object({
        kind: z.enum(["evening", "morning"]).optional().describe("Which digest (default: evening)"),
      }),
      handler: async (args) => {
        const kind = (args as { kind?: DigestKind }).kind ?? "evening";
        const res = await opts.sendNow(kind);
        const lines = Object.entries(res).map(([c, ok]) => `- ${c}: ${ok ? "sent ✅" : "skipped (not active)"}`);
        return textResult(`Digest "${kind}" delivery:\n${lines.join("\n")}`);
      },
    },
  ];
}

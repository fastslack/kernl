/**
 * Reminders RPC Actions — replaces /api/reminders/* mutation routes.
 *
 * Delegates to ReminderService (the source of truth) so the dashboard shares
 * the same behaviour as the MCP tools (Neo4j mirror, repeat handling, etc.).
 */

import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import type { ReminderService } from "./service.js";
import type { RepeatInterval } from "./types.js";

export function remindersRpcActions(service: ReminderService): RpcAction[] {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return [
    {
      name: "reminders.create",
      handler: async (args) => {
        const title = str(args.title).trim();
        const trigger_at = str(args.trigger_at);
        if (!title) throw new Error("Title required");
        if (!trigger_at) throw new Error("trigger_at required");
        const reminder = service.create({
          title,
          body: str(args.body) || undefined,
          trigger_at,
          repeat: (str(args.repeat) as RepeatInterval) || undefined,
        });
        return { ok: true, id: reminder.id };
      },
    },
    {
      name: "reminders.update",
      handler: async (args) => {
        const id = str(args.id);
        if (!id) throw new Error("Missing id");
        const changes: Record<string, unknown> = {};
        if (typeof args.title === "string") changes.title = args.title;
        if (typeof args.body === "string") changes.body = args.body;
        if (typeof args.trigger_at === "string") changes.trigger_at = args.trigger_at;
        if (typeof args.repeat === "string") changes.repeat = args.repeat;
        if (Object.keys(changes).length === 0) throw new Error("No fields");
        const updated = service.update(id, changes);
        if (!updated) throw new Error("Reminder not found");
        return { ok: true };
      },
    },
    {
      name: "reminders.reschedule",
      handler: async (args) => {
        const id = str(args.id);
        const trigger_at = str(args.trigger_at);
        if (!id || !trigger_at) throw new Error("id and trigger_at required");
        const updated = service.update(id, { trigger_at });
        if (!updated) throw new Error("Reminder not found");
        return { ok: true };
      },
    },
    {
      name: "reminders.dismiss",
      handler: async (args) => {
        const id = str(args.id);
        if (!id) throw new Error("Missing id");
        const r = service.dismiss(id);
        if (!r) throw new Error("Reminder not found");
        return { ok: true };
      },
    },
    {
      name: "reminders.snooze",
      handler: async (args) => {
        const id = str(args.id);
        if (!id) throw new Error("Missing id");
        const mins = typeof args.minutes === "number" ? args.minutes : 30;
        const until = new Date(Date.now() + mins * 60_000).toISOString();
        const r = service.snooze(id, until);
        if (!r) throw new Error("Reminder not found");
        return { ok: true };
      },
    },
  ];
}

/**
 * Reminder operations the dashboard reaches over the WS RPC, and for
 * dismiss/snooze over HTTP too (rpcOrCall falls back to /api/reminders/*).
 *
 * Every entry delegates to ReminderService (the source of truth) so the
 * dashboard shares the MCP tools' behaviour (Neo4j mirror, repeat handling).
 * The RPC side already did; the HTTP fallback for dismiss/snooze wrote the
 * row directly, so it skipped the graph mirror and answered ok for an id
 * that did not exist. Now rpc-actions.ts exposes this map as is and
 * api-routes.ts binds the two shared entries to their paths.
 */

import { HttpError, pickArgs, type Operation, type EventBus } from "@kernl/extension-sdk";
import type { ReminderService } from "./service.js";
import type { RepeatInterval } from "./types.js";

const REPEATS: ReadonlyArray<RepeatInterval> = ["none", "daily", "weekly", "monthly"];

export function reminderOperations(service: ReminderService, events?: EventBus | null): Record<string, Operation> {
  const changed = (action: string) => { events?.emit("data.changed", { module: "reminders", action }); };
  const requireId = (input: Record<string, unknown>): string => {
    const { id } = pickArgs(input, { id: "string" });
    if (!id) throw new HttpError(400, "Missing id");
    return id;
  };
  const checkRepeat = (repeat: string | undefined): RepeatInterval | undefined => {
    if (!repeat) return undefined;
    if (!REPEATS.includes(repeat as RepeatInterval)) throw new HttpError(400, `Invalid repeat. Allowed: ${REPEATS.join(", ")}`);
    return repeat as RepeatInterval;
  };

  return {
    "reminders.create": (input) => {
      const args = pickArgs(input, { title: "string", body: "string", trigger_at: "string", repeat: "string" });
      const title = args.title?.trim() ?? "";
      if (!title) throw new HttpError(400, "Title required");
      if (!args.trigger_at) throw new HttpError(400, "trigger_at required");
      const reminder = service.create({
        title,
        body: args.body || undefined,
        trigger_at: args.trigger_at,
        repeat: checkRepeat(args.repeat),
      });
      return { ok: true, id: reminder.id };
    },

    "reminders.update": (input) => {
      const id = requireId(input);
      const { repeat, ...changes } = pickArgs(input, { title: "string", body: "string", trigger_at: "string", repeat: "string" });
      if (Object.keys(changes).length === 0 && repeat === undefined) throw new HttpError(400, "No fields");
      // The service spreads the changes over the row, so an absent key must
      // stay absent rather than arrive as `undefined`.
      const updated = service.update(id, repeat === undefined ? changes : { ...changes, repeat: checkRepeat(repeat) ?? "none" });
      if (!updated) throw new HttpError(404, "Reminder not found");
      return { ok: true };
    },

    "reminders.reschedule": (input) => {
      const { id, trigger_at } = pickArgs(input, { id: "string", trigger_at: "string" });
      if (!id || !trigger_at) throw new HttpError(400, "id and trigger_at required");
      if (!service.update(id, { trigger_at })) throw new HttpError(404, "Reminder not found");
      return { ok: true };
    },

    "reminders.dismiss": (input) => {
      if (!service.dismiss(requireId(input))) throw new HttpError(404, "Reminder not found");
      changed("dismiss");
      return { ok: true };
    },

    "reminders.snooze": (input) => {
      const id = requireId(input);
      const minutes = pickArgs(input, { minutes: "number" }).minutes ?? 30;
      const until = new Date(Date.now() + minutes * 60_000);
      // A `minutes` that lands outside the Date range used to surface as a 400 too.
      if (Number.isNaN(until.getTime())) throw new HttpError(400, "Invalid minutes");
      if (!service.snooze(id, until.toISOString())) throw new HttpError(404, "Reminder not found");
      changed("snooze");
      return { ok: true };
    },
  };
}

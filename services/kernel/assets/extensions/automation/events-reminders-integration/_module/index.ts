/**
 * Events ↔ Reminders Integration extension.
 *
 * This is a glue extension that wires cross-extension behaviors:
 *   - Listens for events:* signals → sends notifications via the kernel
 *     Notifier, and creates Reminder records 24h before opened events.
 *   - Listens for email:urgent (comms) → sends notifications.
 *
 * It has no tools, no migrations, no routes — it's pure event-listener
 * orchestration. Lives as a module so it can be disabled or replaced
 * without touching the kernel core.
 */
import type {
  KernelModule,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import type { ReminderServiceLike } from "../../../../../src/core/types/extensions/reminders.js";
import { setupEventListeners } from "./listeners.js";

export function createEventsRemindersIntegrationModule(): KernelModule {
  return {
    name: "events-reminders-integration",

    async initialize(ctx: ModuleContext) {
      // Resolve the reminders extension lazily — it may or may not be
      // installed. If absent, only the notification listeners run (the
      // events:opened handler that creates reminders is skipped inside
      // setupEventListeners when reminderService is null).
      const remindersHandle = ctx.getModule?.("ext:reminders") as
        | { getService?: () => ReminderServiceLike | null }
        | null;
      const reminderService = remindersHandle?.getService?.() ?? null;

      setupEventListeners({
        events: ctx.events,
        notifier: ctx.notifier,
        reminderService,
        systemRegistry: ctx.systemRegistry,
      });
    },

    getTools(): ToolDefinition[] {
      return [];
    },

    async shutdown() {},
  };
}

export default createEventsRemindersIntegrationModule;

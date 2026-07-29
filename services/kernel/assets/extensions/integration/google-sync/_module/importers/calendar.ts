import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import type { ReminderService } from "../../../../productivity/reminders/_module/service.js";
import type { GoogleClient } from "../google-client.js";
import type { GoogleEvent, ImportResult } from "../../../../../../src/core/integrations/google-types.js";
import type { RepeatInterval } from "../../../../productivity/reminders/_module/types.js";
import { newId, isoNow } from "../../../../../../src/core/helpers.js";
import { log } from "../../../../../../src/core/logger.js";

const CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/**
 * Parse RRULE string to Kernl repeat interval.
 * Only maps DAILY, WEEKLY, MONTHLY. Complex rules return "none".
 */
export function parseRrule(recurrence: string[] | undefined): { repeat: RepeatInterval; note: string } {
  if (!recurrence || recurrence.length === 0) {
    return { repeat: "none", note: "" };
  }

  const rrule = recurrence.find((r) => r.startsWith("RRULE:"));
  if (!rrule) return { repeat: "none", note: "" };

  const freqMatch = rrule.match(/FREQ=(\w+)/);
  if (!freqMatch) return { repeat: "none", note: "" };

  const freq = freqMatch[1].toUpperCase();

  // Check for complex rules (INTERVAL>1, BYDAY with multiple days, COUNT, UNTIL with BYDAY, etc.)
  const hasInterval = /INTERVAL=([2-9]|\d{2,})/.test(rrule);
  if (hasInterval) {
    return { repeat: "none", note: `[Recurrence: ${rrule}]` };
  }

  switch (freq) {
    case "DAILY":
      return { repeat: "daily", note: "" };
    case "WEEKLY":
      return { repeat: "weekly", note: "" };
    case "MONTHLY":
      return { repeat: "monthly", note: "" };
    default:
      return { repeat: "none", note: `[Recurrence: ${rrule}]` };
  }
}

export function mapGoogleEvent(event: GoogleEvent) {
  let triggerAt: string;

  if (event.start?.dateTime) {
    // Timed event — convert to UTC
    triggerAt = new Date(event.start.dateTime).toISOString();
  } else if (event.start?.date) {
    // All-day event — set to 09:00 UTC
    triggerAt = `${event.start.date}T09:00:00.000Z`;
  } else {
    return null;
  }

  const { repeat, note } = parseRrule(event.recurrence);
  const bodyParts: string[] = [];
  if (event.description) bodyParts.push(event.description);
  if (note) bodyParts.push(note);

  return {
    title: event.summary ?? "(no title)",
    body: bodyParts.join("\n\n"),
    trigger_at: triggerAt,
    repeat,
  };
}

export async function importCalendar(
  client: GoogleClient,
  db: SqliteDb,
  reminderService: ReminderService,
): Promise<ImportResult> {
  const result: ImportResult = { source: "calendar", imported: 0, skipped: 0, errors: [] };

  const now = new Date();
  const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 3600_000);

  const events = await client.getPaginated<GoogleEvent>(
    CALENDAR_API_URL,
    {
      timeMin: now.toISOString(),
      timeMax: thirtyDaysLater.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "100",
    },
    "items",
  );

  for (const event of events) {
    if (!event.id) {
      result.skipped++;
      continue;
    }

    // Skip cancelled events
    if (event.status === "cancelled") {
      result.skipped++;
      continue;
    }

    try {
      const existing = db
        .prepare("SELECT local_id FROM google_sync_map WHERE source = 'calendar' AND google_id = ?")
        .get(event.id) as { local_id: string } | undefined;

      if (existing) {
        result.skipped++;
        continue;
      }

      const mapped = mapGoogleEvent(event);
      if (!mapped) {
        result.skipped++;
        continue;
      }

      const reminder = reminderService.create(mapped);

      db.prepare(
        `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
         VALUES (?, 'calendar', ?, ?, 'reminders', ?)`,
      ).run(newId(), event.id, reminder.id, isoNow());

      result.imported++;
    } catch (err) {
      result.errors.push(`Event "${event.summary}": ${String(err)}`);
    }
  }

  db.prepare(
    `INSERT INTO google_sync_meta (source, last_sync_at, items_synced)
     VALUES ('calendar', ?, ?)
     ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at, items_synced = excluded.items_synced`,
  ).run(isoNow(), result.imported);

  log.info(`Calendar sync: ${result.imported} imported, ${result.skipped} skipped`);
  return result;
}

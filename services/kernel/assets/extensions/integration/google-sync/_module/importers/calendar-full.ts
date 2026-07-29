import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import type { GoogleClient } from "../google-client.js";
import type { ImportResult } from "../../../../../../src/core/integrations/google-types.js";
import { newId, isoNow } from "../../../../../../src/core/helpers.js";
import { log } from "../../../../../../src/core/logger.js";

const CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

interface GoogleCalendarEventFull {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  status?: string;
  organizer?: {
    email?: string;
    displayName?: string;
    self?: boolean;
  };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
  }>;
  recurrence?: string[];
  recurringEventId?: string;
  hangoutLink?: string;
  visibility?: string;
}

interface GoogleCalendarListResponse {
  items?: GoogleCalendarEventFull[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export async function importCalendarFull(
  client: GoogleClient,
  db: SqliteDb,
): Promise<ImportResult> {
  const result: ImportResult = { source: "calendar" as any, imported: 0, skipped: 0, errors: [] };

  // Determine time range — incremental via updatedMin or first-time
  const meta = db
    .prepare("SELECT last_sync_at FROM google_sync_meta WHERE source = 'calendar_full'")
    .get() as { last_sync_at: string } | undefined;

  const now = new Date();
  const oneYearAgo = new Date(now.getTime() - 365 * 24 * 3600_000);
  const sixMonthsAhead = new Date(now.getTime() + 180 * 24 * 3600_000);

  const params: Record<string, string> = {
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "500",
    timeMin: oneYearAgo.toISOString(),
    timeMax: sixMonthsAhead.toISOString(),
  };

  if (meta?.last_sync_at) {
    params.updatedMin = meta.last_sync_at;
  }

  const events = await client.getPaginated<GoogleCalendarEventFull>(
    CALENDAR_API_URL,
    params,
    "items",
  );

  log.info(`Calendar full sync: ${events.length} events fetched`);

  const upsert = db.prepare(
    `INSERT INTO google_calendar_events
     (id, google_event_id, calendar_id, title, description, location,
      start_at, end_at, all_day, status, organizer_email, organizer_name,
      attendees, recurrence, recurring_event_id, hangout_link, visibility,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(google_event_id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       location = excluded.location,
       start_at = excluded.start_at,
       end_at = excluded.end_at,
       all_day = excluded.all_day,
       status = excluded.status,
       organizer_email = excluded.organizer_email,
       organizer_name = excluded.organizer_name,
       attendees = excluded.attendees,
       recurrence = excluded.recurrence,
       hangout_link = excluded.hangout_link,
       visibility = excluded.visibility,
       updated_at = excluded.updated_at`,
  );

  const insertSyncMap = db.prepare(
    `INSERT OR IGNORE INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
     VALUES (?, 'calendar_full', ?, ?, 'google_calendar_events', ?)`,
  );

  for (const event of events) {
    if (!event.id) {
      result.skipped++;
      continue;
    }

    if (event.status === "cancelled") {
      // Remove cancelled events from local store
      db.prepare("DELETE FROM google_calendar_events WHERE google_event_id = ?").run(event.id);
      result.skipped++;
      continue;
    }

    try {
      const startAt = event.start?.dateTime
        ? new Date(event.start.dateTime).toISOString()
        : event.start?.date
          ? `${event.start.date}T00:00:00.000Z`
          : "";

      const endAt = event.end?.dateTime
        ? new Date(event.end.dateTime).toISOString()
        : event.end?.date
          ? `${event.end.date}T00:00:00.000Z`
          : "";

      if (!startAt) {
        result.skipped++;
        continue;
      }

      const allDay = event.start?.date && !event.start?.dateTime ? 1 : 0;

      const attendees = (event.attendees ?? []).map((a) => ({
        email: a.email ?? "",
        name: a.displayName ?? "",
        responseStatus: a.responseStatus ?? "needsAction",
        self: a.self ?? false,
        organizer: a.organizer ?? false,
      }));

      const recurrence = event.recurrence ?? [];
      const eventId = newId();
      const nowStr = isoNow();

      upsert.run(
        eventId,
        event.id,
        "primary",
        event.summary ?? "",
        (event.description ?? "").slice(0, 5000),
        event.location ?? "",
        startAt,
        endAt,
        allDay,
        event.status ?? "confirmed",
        event.organizer?.email ?? "",
        event.organizer?.displayName ?? "",
        JSON.stringify(attendees),
        JSON.stringify(recurrence),
        event.recurringEventId ?? "",
        event.hangoutLink ?? "",
        event.visibility ?? "default",
        nowStr,
        nowStr,
      );

      insertSyncMap.run(newId(), event.id, eventId, nowStr);
      result.imported++;
    } catch (err) {
      result.errors.push(`Event "${event.summary}": ${String(err)}`);
    }
  }

  // Update sync meta
  db.prepare(
    `INSERT INTO google_sync_meta (source, last_sync_at, items_synced)
     VALUES ('calendar_full', ?, ?)
     ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at, items_synced = excluded.items_synced`,
  ).run(isoNow(), result.imported);

  log.info(`Calendar full sync: ${result.imported} events stored, ${result.skipped} skipped, ${result.errors.length} errors`);
  return result;
}

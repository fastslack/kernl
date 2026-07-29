import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { googleSyncMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/001_google_sync.js";
import { mapGoogleContact } from "../assets/extensions/integration/google-sync/_module/importers/contacts.js";
import { mapGoogleEvent, parseRrule } from "../assets/extensions/integration/google-sync/_module/importers/calendar.js";
import { mapGoogleTask } from "../assets/extensions/integration/google-sync/_module/importers/tasks.js";
import { mapOtherContact } from "../assets/extensions/integration/google-sync/_module/importers/other-contacts.js";
import { mapTakeoutPlace } from "../assets/extensions/integration/google-sync/_module/importers/takeout-places.js";
import type {
  GooglePerson, GoogleEvent, GoogleTask,
  GoogleOtherContact, TakeoutFeature,
} from "../src/core/integrations/google-types.js";
import { newId, isoNow } from "../src/core/helpers.js";
import { shoppingMigrations } from "../assets/extensions/home/shopping/_module/migrations/001_shopping.js";

describe("Google Sync — Contact mapping", () => {
  it("maps a full Google contact to CRM fields", () => {
    const person: GooglePerson = {
      resourceName: "people/c123",
      names: [{ displayName: "Juan García" }],
      emailAddresses: [{ value: "juan@example.com" }],
      phoneNumbers: [{ value: "+34600123456" }],
      organizations: [{ name: "ACME Corp" }],
      biographies: [{ value: "Met at conference" }],
    };

    const mapped = mapGoogleContact(person);
    expect(mapped.name).toBe("Juan García");
    expect(mapped.email).toBe("juan@example.com");
    expect(mapped.phone).toBe("+34600123456");
    expect(mapped.company).toBe("ACME Corp");
    expect(mapped.notes).toBe("Met at conference");
    expect(mapped.relationship).toBe("acquaintance");
  });

  it("handles missing optional fields with empty strings", () => {
    const person: GooglePerson = {
      resourceName: "people/c456",
      names: [{ displayName: "Alice" }],
    };

    const mapped = mapGoogleContact(person);
    expect(mapped.name).toBe("Alice");
    expect(mapped.email).toBe("");
    expect(mapped.phone).toBe("");
    expect(mapped.company).toBe("");
    expect(mapped.notes).toBe("");
  });

  it("handles completely empty person", () => {
    const person: GooglePerson = { resourceName: "people/c789" };
    const mapped = mapGoogleContact(person);
    expect(mapped.name).toBe("");
  });
});

describe("Google Sync — Calendar mapping", () => {
  it("maps a timed event", () => {
    const event: GoogleEvent = {
      id: "ev1",
      summary: "Team standup",
      description: "Daily sync",
      start: { dateTime: "2026-03-01T10:00:00+01:00" },
      end: { dateTime: "2026-03-01T10:30:00+01:00" },
    };

    const mapped = mapGoogleEvent(event);
    expect(mapped).not.toBeNull();
    expect(mapped!.title).toBe("Team standup");
    expect(mapped!.body).toBe("Daily sync");
    // Should be converted to UTC
    expect(mapped!.trigger_at).toContain("2026-03-01T09:00:00");
    expect(mapped!.repeat).toBe("none");
  });

  it("maps an all-day event to 09:00 UTC", () => {
    const event: GoogleEvent = {
      id: "ev2",
      summary: "Birthday",
      start: { date: "2026-04-15" },
    };

    const mapped = mapGoogleEvent(event);
    expect(mapped).not.toBeNull();
    expect(mapped!.trigger_at).toBe("2026-04-15T09:00:00.000Z");
  });

  it("returns null for event without start", () => {
    const event: GoogleEvent = { id: "ev3", summary: "Broken event" };
    expect(mapGoogleEvent(event)).toBeNull();
  });

  it("sets title to (no title) when summary is missing", () => {
    const event: GoogleEvent = {
      id: "ev4",
      start: { dateTime: "2026-05-01T12:00:00Z" },
    };
    const mapped = mapGoogleEvent(event);
    expect(mapped!.title).toBe("(no title)");
  });
});

describe("Google Sync — RRULE parsing", () => {
  it("parses DAILY recurrence", () => {
    const { repeat, note } = parseRrule(["RRULE:FREQ=DAILY"]);
    expect(repeat).toBe("daily");
    expect(note).toBe("");
  });

  it("parses WEEKLY recurrence", () => {
    const { repeat } = parseRrule(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    expect(repeat).toBe("weekly");
  });

  it("parses MONTHLY recurrence", () => {
    const { repeat } = parseRrule(["RRULE:FREQ=MONTHLY"]);
    expect(repeat).toBe("monthly");
  });

  it("returns none for empty recurrence", () => {
    expect(parseRrule(undefined).repeat).toBe("none");
    expect(parseRrule([]).repeat).toBe("none");
  });

  it("returns none with note for YEARLY", () => {
    const { repeat, note } = parseRrule(["RRULE:FREQ=YEARLY"]);
    expect(repeat).toBe("none");
    expect(note).toContain("YEARLY");
  });

  it("returns none with note for complex INTERVAL", () => {
    const { repeat, note } = parseRrule(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH"]);
    expect(repeat).toBe("none");
    expect(note).toContain("INTERVAL=2");
  });

  it("handles non-RRULE entries", () => {
    const { repeat } = parseRrule(["EXDATE:20260301T100000Z"]);
    expect(repeat).toBe("none");
  });
});

describe("Google Sync — Task mapping", () => {
  it("maps a Google task with due date", () => {
    const task: GoogleTask = {
      id: "t1",
      title: "Buy groceries",
      notes: "Milk, eggs, bread",
      due: "2026-03-15T00:00:00.000Z",
      status: "needsAction",
    };

    const mapped = mapGoogleTask(task, "My Tasks");
    expect(mapped.title).toBe("Buy groceries");
    expect(mapped.description).toBe("Milk, eggs, bread");
    expect(mapped.due_date).toBe("2026-03-15");
    expect(mapped.status).toBe("todo");
    expect(mapped.priority).toBe("medium");
  });

  it("maps completed task status", () => {
    const task: GoogleTask = { id: "t2", title: "Done task", status: "completed" };
    const mapped = mapGoogleTask(task, "Work");
    expect(mapped.status).toBe("done");
  });

  it("maps list title to context", () => {
    expect(mapGoogleTask({ id: "t", title: "x" }, "Work").context).toBe("@work");
    expect(mapGoogleTask({ id: "t", title: "x" }, "Home").context).toBe("@home");
    expect(mapGoogleTask({ id: "t", title: "x" }, "Errands").context).toBe("@errands");
    expect(mapGoogleTask({ id: "t", title: "x" }, "Custom List").context).toBe("@custom list");
  });

  it("maps Spanish list names", () => {
    expect(mapGoogleTask({ id: "t", title: "x" }, "Trabajo").context).toBe("@work");
    expect(mapGoogleTask({ id: "t", title: "x" }, "Casa").context).toBe("@home");
    expect(mapGoogleTask({ id: "t", title: "x" }, "Recados").context).toBe("@errands");
  });

  it("handles missing due date", () => {
    const task: GoogleTask = { id: "t3", title: "No due", status: "needsAction" };
    const mapped = mapGoogleTask(task, "My Tasks");
    expect(mapped.due_date).toBeUndefined();
  });
});

describe("Google Sync — Other Contacts mapping", () => {
  it("maps an other contact with all fields", () => {
    const contact: GoogleOtherContact = {
      resourceName: "otherContacts/c999",
      names: [{ displayName: "Maria López" }],
      emailAddresses: [{ value: "maria@example.com" }],
      phoneNumbers: [{ value: "+34611222333" }],
    };

    const mapped = mapOtherContact(contact);
    expect(mapped.name).toBe("Maria López");
    expect(mapped.email).toBe("maria@example.com");
    expect(mapped.phone).toBe("+34611222333");
    expect(mapped.relationship).toBe("acquaintance");
    expect(mapped.notes).toContain("Other Contacts");
  });

  it("handles email-only other contact", () => {
    const contact: GoogleOtherContact = {
      resourceName: "otherContacts/c888",
      emailAddresses: [{ value: "unknown@company.com" }],
    };

    const mapped = mapOtherContact(contact);
    expect(mapped.name).toBe("");
    expect(mapped.email).toBe("unknown@company.com");
  });

  it("handles empty other contact", () => {
    const contact: GoogleOtherContact = { resourceName: "otherContacts/c777" };
    const mapped = mapOtherContact(contact);
    expect(mapped.name).toBe("");
    expect(mapped.email).toBe("");
  });
});

describe("Google Sync — Takeout Places mapping", () => {
  it("maps a feature with geometry coordinates", () => {
    const feature: TakeoutFeature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-3.7038, 40.4168] },
      properties: {
        name: "Mercadona Sol",
        address: "Calle Mayor 1, Madrid",
        google_maps_url: "https://maps.google.com/?cid=12345",
        Comment: "STARRED",
        date: "2025-01-15",
      },
    };

    const mapped = mapTakeoutPlace(feature);
    expect(mapped.name).toBe("Mercadona Sol");
    expect(mapped.location).toContain("Calle Mayor 1, Madrid");
    expect(mapped.location).toContain("40.4168");
    expect(mapped.location).toContain("-3.7038");
    expect(mapped.notes).toContain("STARRED");
    expect(mapped.notes).toContain("maps.google.com");
  });

  it("maps a feature with location.name and geo_coordinates", () => {
    const feature: TakeoutFeature = {
      type: "Feature",
      properties: {
        location: {
          name: "Café Central",
          address: "Plaza del Ángel 10",
          geo_coordinates: { latitude: 40.4145, longitude: -3.7005 },
        },
      },
    };

    const mapped = mapTakeoutPlace(feature);
    expect(mapped.name).toBe("Café Central");
    expect(mapped.location).toContain("Plaza del Ángel 10");
    expect(mapped.location).toContain("40.4145");
  });

  it("maps a feature with only name and address", () => {
    const feature: TakeoutFeature = {
      type: "Feature",
      properties: {
        name: "Farmacia",
        address: "Calle Luna 5",
      },
    };

    const mapped = mapTakeoutPlace(feature);
    expect(mapped.name).toBe("Farmacia");
    expect(mapped.location).toBe("Calle Luna 5");
  });

  it("handles feature with no name", () => {
    const feature: TakeoutFeature = {
      type: "Feature",
      properties: {},
    };

    const mapped = mapTakeoutPlace(feature);
    expect(mapped.name).toBe("");
  });
});

describe("Google Sync — Sync map deduplication", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "crm", crmMigrations);
    runMigrations(db, "tasks", tasksMigrations);
    runMigrations(db, "google-sync", googleSyncMigrations);
  });

  afterEach(() => {
    db.close();
  });

  it("creates sync map entry", () => {
    const id = newId();
    const now = isoNow();
    db.prepare(
      `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
       VALUES (?, 'contacts', ?, ?, 'contacts', ?)`,
    ).run(id, "people/c123", "local-uuid", now);

    const entry = db.prepare("SELECT * FROM google_sync_map WHERE google_id = ?").get("people/c123") as {
      source: string;
      google_id: string;
      local_id: string;
    };
    expect(entry.source).toBe("contacts");
    expect(entry.local_id).toBe("local-uuid");
  });

  it("prevents duplicate google_id per source", () => {
    const now = isoNow();
    db.prepare(
      `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
       VALUES (?, 'contacts', ?, ?, 'contacts', ?)`,
    ).run(newId(), "people/c123", "local-1", now);

    expect(() =>
      db.prepare(
        `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
         VALUES (?, 'contacts', ?, ?, 'contacts', ?)`,
      ).run(newId(), "people/c123", "local-2", now),
    ).toThrow();
  });

  it("allows same google_id in different sources", () => {
    const now = isoNow();
    db.prepare(
      `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
       VALUES (?, 'contacts', ?, ?, 'contacts', ?)`,
    ).run(newId(), "shared-id", "local-1", now);

    // Should not throw — different source
    db.prepare(
      `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
       VALUES (?, 'tasks', ?, ?, 'tasks', ?)`,
    ).run(newId(), "shared-id", "local-2", now);

    const count = db.prepare("SELECT COUNT(*) as c FROM google_sync_map").get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("supports new source types (gmail, other_contacts, takeout_places)", () => {
    const now = isoNow();
    const sources = ["gmail", "other_contacts", "takeout_places"] as const;

    for (const source of sources) {
      db.prepare(
        `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
         VALUES (?, ?, ?, ?, 'test', ?)`,
      ).run(newId(), source, `id-${source}`, `local-${source}`, now);
    }

    const count = db.prepare("SELECT COUNT(*) as c FROM google_sync_map").get() as { c: number };
    expect(count.c).toBe(3);
  });

  it("supports new source types in sync_meta", () => {
    const now = isoNow();
    db.prepare(
      `INSERT INTO google_sync_meta (source, last_sync_at, items_synced)
       VALUES ('gmail', ?, 42)`,
    ).run(now);

    const meta = db.prepare("SELECT * FROM google_sync_meta WHERE source = 'gmail'").get() as {
      items_synced: number;
    };
    expect(meta.items_synced).toBe(42);
  });

  it("updates sync meta with UPSERT", () => {
    const now = isoNow();
    db.prepare(
      `INSERT INTO google_sync_meta (source, last_sync_at, items_synced)
       VALUES ('contacts', ?, 5)
       ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at, items_synced = excluded.items_synced`,
    ).run(now);

    // Second sync — should update, not insert
    db.prepare(
      `INSERT INTO google_sync_meta (source, last_sync_at, items_synced)
       VALUES ('contacts', ?, 10)
       ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at, items_synced = excluded.items_synced`,
    ).run(now);

    const meta = db.prepare("SELECT * FROM google_sync_meta WHERE source = 'contacts'").get() as {
      items_synced: number;
    };
    expect(meta.items_synced).toBe(10);
  });
});

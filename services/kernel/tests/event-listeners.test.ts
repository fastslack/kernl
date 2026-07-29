import { describe, it, expect, beforeEach, vi } from "bun:test";
import { EventBus } from "../src/core/event-bus.js";
import { setupEventListeners } from "../assets/extensions/automation/events-reminders-integration/_module/listeners.js";
import type { Notifier } from "../src/core/notify/notifier.js";
import type { ReminderService } from "../assets/extensions/productivity/reminders/_module/service.js";
import type { EventsModuleEvents } from "../assets/extensions/people/events/_module/service.js";

describe("Event Listeners", () => {
  let events: EventBus;
  let mockNotifier: Notifier;
  let mockReminderService: ReminderService;

  beforeEach(() => {
    events = new EventBus();

    // Mock notifier
    mockNotifier = {
      send: vi.fn().mockResolvedValue(true),
      mattermostConfigured: false,
      telegramConfigured: true,
      configured: true,
    } as unknown as Notifier;

    // Mock reminder service
    mockReminderService = {
      create: vi.fn().mockReturnValue({ id: "reminder-1", title: "Test" }),
    } as unknown as ReminderService;
  });

  describe("events:confirmed listener", () => {
    it("sends notification when event is confirmed", async () => {
      setupEventListeners({
        events,
        notifier: mockNotifier,
        reminderService: mockReminderService,
      });

      const payload: EventsModuleEvents["events:confirmed"] = {
        event: {
          id: "event-1",
          title: "Fulbito del Jueves",
          description: "",
          type: "sports",
          status: "confirmed",
          start_at: "2025-03-06T20:00:00",
          end_at: null,
          duration_minutes: 90,
          location: "Cancha El Gol",
          location_url: "",
          min_attendees: 10,
          max_attendees: 14,
          cost_per_person_cents: 500,
          cost_currency: "EUR",
          organizer_contact_id: null,
          recurrence: null,
          parent_event_id: null,
          notes: "",
          created_at: "2025-03-01T12:00:00",
          updated_at: "2025-03-01T12:00:00",
          attendees: [],
          summary: {
            yes: 10,
            no: 2,
            maybe: 0,
            pending: 0,
            waitlist: 0,
            total_invited: 12,
            spots_available: 4,
            needs_more: 0,
            is_confirmed: true,
            is_full: false,
          },
        },
      };

      await events.emit("events:confirmed", payload);

      expect(mockNotifier.send).toHaveBeenCalledTimes(1);
      expect(mockNotifier.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("Event Confirmed"),
          body: expect.stringContaining("10/10"),
        }),
      );
    });
  });

  describe("events:opened listener", () => {
    it("creates reminder 24h before event", async () => {
      setupEventListeners({
        events,
        notifier: mockNotifier,
        reminderService: mockReminderService,
      });

      // Event in 3 days
      const eventStart = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const payload: EventsModuleEvents["events:opened"] = {
        event: {
          id: "event-1",
          title: "Future Event",
          description: "",
          type: "social",
          status: "open",
          start_at: eventStart.toISOString(),
          end_at: null,
          duration_minutes: 90,
          location: "Test Location",
          location_url: "",
          min_attendees: 5,
          max_attendees: null,
          cost_per_person_cents: 0,
          cost_currency: "EUR",
          organizer_contact_id: null,
          recurrence: null,
          parent_event_id: null,
          notes: "",
          created_at: "2025-03-01T12:00:00",
          updated_at: "2025-03-01T12:00:00",
          attendees: [],
          summary: {
            yes: 0,
            no: 0,
            maybe: 0,
            pending: 0,
            waitlist: 0,
            total_invited: 0,
            spots_available: Infinity,
            needs_more: 5,
            is_confirmed: false,
            is_full: false,
          },
        },
      };

      await events.emit("events:opened", payload);

      expect(mockReminderService.create).toHaveBeenCalledTimes(1);
      expect(mockReminderService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("Event tomorrow"),
          notify_telegram: true,
          notify_mattermost: true,
        }),
      );
    });

    it("skips reminder when event starts within 24h", async () => {
      setupEventListeners({
        events,
        notifier: mockNotifier,
        reminderService: mockReminderService,
      });

      // Event in 12 hours (less than 24h)
      const eventStart = new Date(Date.now() + 12 * 60 * 60 * 1000);
      const payload: EventsModuleEvents["events:opened"] = {
        event: {
          id: "event-1",
          title: "Soon Event",
          description: "",
          type: "social",
          status: "open",
          start_at: eventStart.toISOString(),
          end_at: null,
          duration_minutes: 90,
          location: "",
          location_url: "",
          min_attendees: 1,
          max_attendees: null,
          cost_per_person_cents: 0,
          cost_currency: "EUR",
          organizer_contact_id: null,
          recurrence: null,
          parent_event_id: null,
          notes: "",
          created_at: "2025-03-01T12:00:00",
          updated_at: "2025-03-01T12:00:00",
          attendees: [],
          summary: {
            yes: 0,
            no: 0,
            maybe: 0,
            pending: 0,
            waitlist: 0,
            total_invited: 0,
            spots_available: Infinity,
            needs_more: 1,
            is_confirmed: false,
            is_full: false,
          },
        },
      };

      await events.emit("events:opened", payload);

      expect(mockReminderService.create).not.toHaveBeenCalled();
    });

    it("works without reminder service", async () => {
      // No reminder service = no auto-reminder feature
      setupEventListeners({
        events,
        notifier: mockNotifier,
        reminderService: null,
      });

      const eventStart = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const payload: EventsModuleEvents["events:opened"] = {
        event: {
          id: "event-1",
          title: "Test",
          description: "",
          type: "social",
          status: "open",
          start_at: eventStart.toISOString(),
          end_at: null,
          duration_minutes: 90,
          location: "",
          location_url: "",
          min_attendees: 1,
          max_attendees: null,
          cost_per_person_cents: 0,
          cost_currency: "EUR",
          organizer_contact_id: null,
          recurrence: null,
          parent_event_id: null,
          notes: "",
          created_at: "2025-03-01T12:00:00",
          updated_at: "2025-03-01T12:00:00",
          attendees: [],
          summary: {
            yes: 0,
            no: 0,
            maybe: 0,
            pending: 0,
            waitlist: 0,
            total_invited: 0,
            spots_available: Infinity,
            needs_more: 1,
            is_confirmed: false,
            is_full: false,
          },
        },
      };

      // Should not throw
      await expect(events.emit("events:opened", payload)).resolves.toBeUndefined();
    });
  });

  describe("events:full listener", () => {
    it("sends notification when event reaches max capacity", async () => {
      setupEventListeners({
        events,
        notifier: mockNotifier,
        reminderService: mockReminderService,
      });

      const payload: EventsModuleEvents["events:full"] = {
        event: {
          id: "event-1",
          title: "Full Event",
          description: "",
          type: "sports",
          status: "confirmed",
          start_at: "2025-03-06T20:00:00",
          end_at: null,
          duration_minutes: 90,
          location: "",
          location_url: "",
          min_attendees: 5,
          max_attendees: 10,
          cost_per_person_cents: 0,
          cost_currency: "EUR",
          organizer_contact_id: null,
          recurrence: null,
          parent_event_id: null,
          notes: "",
          created_at: "2025-03-01T12:00:00",
          updated_at: "2025-03-01T12:00:00",
          attendees: [],
          summary: {
            yes: 10,
            no: 0,
            maybe: 0,
            pending: 0,
            waitlist: 2,
            total_invited: 12,
            spots_available: 0,
            needs_more: 0,
            is_confirmed: true,
            is_full: true,
          },
        },
      };

      await events.emit("events:full", payload);

      expect(mockNotifier.send).toHaveBeenCalledTimes(1);
      expect(mockNotifier.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("Event Full"),
          body: expect.stringContaining("10"),
        }),
      );
    });
  });

  describe("events:cancelled listener", () => {
    it("sends high-priority notification when event is cancelled", async () => {
      setupEventListeners({
        events,
        notifier: mockNotifier,
        reminderService: mockReminderService,
      });

      const payload: EventsModuleEvents["events:cancelled"] = {
        event: {
          id: "event-1",
          title: "Cancelled Event",
          description: "",
          type: "sports",
          status: "cancelled",
          start_at: "2025-03-06T20:00:00",
          end_at: null,
          duration_minutes: 90,
          location: "",
          location_url: "",
          min_attendees: 10,
          max_attendees: null,
          cost_per_person_cents: 0,
          cost_currency: "EUR",
          organizer_contact_id: null,
          recurrence: null,
          parent_event_id: null,
          notes: "",
          created_at: "2025-03-01T12:00:00",
          updated_at: "2025-03-01T12:00:00",
          attendees: [],
          summary: {
            yes: 3,
            no: 5,
            maybe: 0,
            pending: 2,
            waitlist: 0,
            total_invited: 10,
            spots_available: Infinity,
            needs_more: 7,
            is_confirmed: false,
            is_full: false,
          },
        },
      };

      await events.emit("events:cancelled", payload);

      expect(mockNotifier.send).toHaveBeenCalledTimes(1);
      expect(mockNotifier.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("Event Cancelled"),
          priority: "high",
        }),
      );
    });
  });

  describe("events:completed listener", () => {
    it("sends summary notification when event is completed", async () => {
      setupEventListeners({
        events,
        notifier: mockNotifier,
        reminderService: mockReminderService,
      });

      const payload: EventsModuleEvents["events:completed"] = {
        event: {
          id: "event-1",
          title: "Completed Event",
          description: "",
          type: "sports",
          status: "completed",
          start_at: "2025-03-06T20:00:00",
          end_at: null,
          duration_minutes: 90,
          location: "",
          location_url: "",
          min_attendees: 10,
          max_attendees: null,
          cost_per_person_cents: 500,
          cost_currency: "EUR",
          organizer_contact_id: null,
          recurrence: null,
          parent_event_id: null,
          notes: "",
          created_at: "2025-03-01T12:00:00",
          updated_at: "2025-03-01T12:00:00",
          attendees: [],
          summary: {
            yes: 10,
            no: 2,
            maybe: 0,
            pending: 0,
            waitlist: 0,
            total_invited: 12,
            spots_available: Infinity,
            needs_more: 0,
            is_confirmed: true,
            is_full: false,
          },
        },
        summary: {
          event_id: "event-1",
          title: "Completed Event",
          date: "2025-03-06T20:00:00",
          location: "Cancha",
          final_attendance: 10,
          total_invited: 12,
          attendance_rate: 0.83,
          confirmed_attendees: [],
          no_shows: ["Pedro", "Juan"],
          total_cost_cents: 5000,
          cost_per_person_cents: 500,
          cost_currency: "EUR",
          met_minimum: true,
        },
      };

      await events.emit("events:completed", payload);

      expect(mockNotifier.send).toHaveBeenCalledTimes(1);
      expect(mockNotifier.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("Event Summary"),
          body: expect.stringContaining("83%"),
        }),
      );
    });
  });

  describe("events:waitlist_promoted listener", () => {
    it("sends notification when someone is promoted from waitlist", async () => {
      setupEventListeners({
        events,
        notifier: mockNotifier,
        reminderService: mockReminderService,
      });

      const payload: EventsModuleEvents["events:waitlist_promoted"] = {
        event: {
          id: "event-1",
          title: "Test Event",
          description: "",
          type: "sports",
          status: "confirmed",
          start_at: "2025-03-06T20:00:00",
          end_at: null,
          duration_minutes: 90,
          location: "",
          location_url: "",
          min_attendees: 5,
          max_attendees: 10,
          cost_per_person_cents: 0,
          cost_currency: "EUR",
          organizer_contact_id: null,
          recurrence: null,
          parent_event_id: null,
          notes: "",
          created_at: "2025-03-01T12:00:00",
          updated_at: "2025-03-01T12:00:00",
          attendees: [],
          summary: {
            yes: 10,
            no: 0,
            maybe: 0,
            pending: 0,
            waitlist: 1,
            total_invited: 11,
            spots_available: 0,
            needs_more: 0,
            is_confirmed: true,
            is_full: true,
          },
        },
        attendee: {
          id: "attendee-1",
          event_id: "event-1",
          contact_id: null,
          name: "Carlos Gomez",
          phone: "+1234567890",
          rsvp_status: "yes",
          rsvp_at: "2025-03-05T10:00:00",
          waitlist_position: null,
          notes: "",
          created_at: "2025-03-04T12:00:00",
          updated_at: "2025-03-05T10:00:00",
        },
      };

      await events.emit("events:waitlist_promoted", payload);

      expect(mockNotifier.send).toHaveBeenCalledTimes(1);
      expect(mockNotifier.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("Waitlist Update"),
          body: expect.stringContaining("Carlos Gomez"),
        }),
      );
    });
  });
});

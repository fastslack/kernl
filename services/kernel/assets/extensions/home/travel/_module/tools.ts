import { z } from "zod";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { TravelService } from "./service.js";

import { formatCents } from "../../../../../src/core/formatting.js";

export function travelTools(svc: TravelService): ToolDefinition[] {
  return [
    // ── Trips ──────────────────────────────────────────────────────────────────
    {
      name: "kernel_travel_create_trip",
      description: "Create a new trip",
      inputSchema: z.object({
        title: z.string(),
        destination: z.string(),
        start_date: z.string().describe("ISO date YYYY-MM-DD"),
        end_date: z.string().describe("ISO date YYYY-MM-DD"),
        country_code: z.string().optional().describe("ISO 3166-1 alpha-2 e.g. DE"),
        purpose: z.enum(["leisure", "business", "family", "medical", "other"]).optional().default("leisure"),
        budget_cents: z.number().optional().describe("Budget in cents"),
        currency: z.string().optional().default("EUR"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        try {
          const trip = svc.createTrip(args as any);
          return textResult(
            `## Trip Created: ${trip.title}\n- Destination: ${trip.destination}\n- Dates: ${trip.start_date} → ${trip.end_date}\n- Budget: ${formatCents(trip.budget_cents, trip.currency)}\n- ID: \`${trip.id}\``
          );
        } catch (e) {
          return errorResult(String(e));
        }
      },
    },
    {
      name: "kernel_travel_list_trips",
      description: "List all trips",
      inputSchema: z.object({
        status: z.enum(["planning", "booked", "in_progress", "completed", "cancelled"]).optional(),
        upcoming: z.boolean().optional().describe("Only show trips that haven't ended yet"),
      }),
      handler: async (args) => {
        const trips = svc.listTrips(args as any);
        if (!trips.length) return textResult("No trips found.");
        const lines = trips.map(t =>
          `- **${t.title}** → ${t.destination} [${t.status}] ${t.start_date} → ${t.end_date}`
        );
        return textResult(`## Trips (${trips.length})\n${lines.join("\n")}`);
      },
    },
    {
      name: "kernel_travel_update_trip",
      description: "Update a trip's details or status",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional(),
        destination: z.string().optional(),
        status: z.enum(["planning", "booked", "in_progress", "completed", "cancelled"]).optional(),
        budget_cents: z.number().optional(),
        notes: z.string().optional(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as { id: string; [key: string]: unknown };
        const trip = svc.updateTrip(id, changes as any);
        if (!trip) return errorResult("Trip not found");
        return textResult(`Trip updated: **${trip.title}** [${trip.status}]`);
      },
    },
    {
      name: "kernel_travel_itinerary",
      description: "Get full itinerary for a trip (flights, hotels, activities, budget)",
      inputSchema: z.object({ trip_id: z.string() }),
      handler: async (args) => {
        const { trip_id } = args as { trip_id: string };
        const data = svc.getItinerary(trip_id);
        if (!data.trip) return errorResult("Trip not found");
        const { trip, flights, accommodations, activities, budget, packing } = data;

        const flightLines = flights.map(f =>
          `  - ${f.origin}→${f.destination} ${f.departs_at.slice(0, 16)} [${f.status}]${f.flight_number ? ` ${f.airline} ${f.flight_number}` : ""}`
        );
        const accomLines = accommodations.map(a =>
          `  - **${a.name}** (${a.type}) ${a.check_in} → ${a.check_out}`
        );
        const activityLines = activities.slice(0, 10).map(a =>
          `  - ${a.date} ${a.start_time ? a.start_time + " " : ""}**${a.title}** [${a.status}]`
        );
        const catLines = Object.entries(budget.by_category).map(([k, v]) =>
          `  - ${k}: ${formatCents(v, trip.currency)}`
        );

        return textResult([
          `## ${trip.title} — ${trip.destination}`,
          `${trip.start_date} → ${trip.end_date} [${trip.status}]`,
          `\n### Flights (${flights.length})`,
          ...flightLines,
          `\n### Accommodation (${accommodations.length})`,
          ...accomLines,
          `\n### Activities (${activities.length})`,
          ...activityLines,
          activities.length > 10 ? `  ... and ${activities.length - 10} more` : "",
          `\n### Budget`,
          `- Budget: ${formatCents(budget.budget_cents, trip.currency)}`,
          `- Spent: ${formatCents(budget.total_spent_cents, trip.currency)}`,
          `- Remaining: ${formatCents(budget.remaining_cents, trip.currency)}`,
          ...catLines,
          `\n### Packing: ${packing.packed}/${packing.total} items packed`,
        ].filter(Boolean).join("\n"));
      },
    },

    // ── Flights ────────────────────────────────────────────────────────────────
    {
      name: "kernel_travel_add_flight",
      description: "Add a flight to a trip",
      inputSchema: z.object({
        trip_id: z.string(),
        origin: z.string().describe("IATA code e.g. AMS"),
        destination: z.string().describe("IATA code e.g. CDG"),
        departs_at: z.string().describe("ISO datetime"),
        arrives_at: z.string().describe("ISO datetime"),
        airline: z.string().optional(),
        flight_number: z.string().optional(),
        seat: z.string().optional(),
        booking_ref: z.string().optional(),
        price_cents: z.number().optional(),
        currency: z.string().optional().default("EUR"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        try {
          const flight = svc.addFlight(args as any);
          return textResult(
            `Flight added: **${flight.origin}→${flight.destination}** ${flight.departs_at.slice(0, 16)}${flight.flight_number ? ` (${flight.airline} ${flight.flight_number})` : ""}`
          );
        } catch (e) {
          return errorResult(String(e));
        }
      },
    },
    {
      name: "kernel_travel_update_flight",
      description: "Update flight status, gate, seat",
      inputSchema: z.object({
        id: z.string(),
        status: z.enum(["booked", "checked_in", "boarded", "completed", "cancelled"]).optional(),
        terminal: z.string().optional(),
        gate: z.string().optional(),
        seat: z.string().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as { id: string; [key: string]: unknown };
        const flight = svc.updateFlight(id, changes as any);
        if (!flight) return errorResult("Flight not found");
        return textResult(`Flight updated: ${flight.origin}→${flight.destination} [${flight.status}]`);
      },
    },

    // ── Accommodation ──────────────────────────────────────────────────────────
    {
      name: "kernel_travel_add_accommodation",
      description: "Add accommodation to a trip (hotel, Airbnb, hostel, etc.)",
      inputSchema: z.object({
        trip_id: z.string(),
        name: z.string(),
        type: z.enum(["hotel", "airbnb", "hostel", "camping", "friend", "other"]).optional().default("hotel"),
        check_in: z.string().describe("ISO date"),
        check_out: z.string().describe("ISO date"),
        address: z.string().optional(),
        confirmation: z.string().optional(),
        price_cents: z.number().optional(),
        currency: z.string().optional().default("EUR"),
        url: z.string().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        try {
          const a = svc.addAccommodation(args as any);
          return textResult(`Accommodation added: **${a.name}** (${a.type}) ${a.check_in} → ${a.check_out}`);
        } catch (e) {
          return errorResult(String(e));
        }
      },
    },

    // ── Activities ─────────────────────────────────────────────────────────────
    {
      name: "kernel_travel_add_activity",
      description: "Add an activity or itinerary item to a trip",
      inputSchema: z.object({
        trip_id: z.string(),
        title: z.string(),
        date: z.string().describe("ISO date"),
        type: z.enum(["attraction", "restaurant", "transport", "tour", "event", "meeting", "other"]).optional().default("attraction"),
        start_time: z.string().optional().describe("HH:MM"),
        end_time: z.string().optional().describe("HH:MM"),
        location: z.string().optional(),
        booking_ref: z.string().optional(),
        price_cents: z.number().optional(),
        currency: z.string().optional().default("EUR"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        try {
          const a = svc.addActivity(args as any);
          return textResult(`Activity added: **${a.title}** on ${a.date}${a.start_time ? ` at ${a.start_time}` : ""}`);
        } catch (e) {
          return errorResult(String(e));
        }
      },
    },
    {
      name: "kernel_travel_activities",
      description: "List activities for a trip, optionally filtered by date",
      inputSchema: z.object({
        trip_id: z.string(),
        date: z.string().optional().describe("ISO date to filter"),
      }),
      handler: async (args) => {
        const { trip_id, date } = args as { trip_id: string; date?: string };
        const activities = svc.listActivities(trip_id, date);
        if (!activities.length) return textResult("No activities found.");
        const lines = activities.map(a =>
          `- ${a.date} ${a.start_time || "??:??"} **${a.title}** (${a.type}) [${a.status}]${a.location ? ` @ ${a.location}` : ""}`
        );
        return textResult(`## Activities (${activities.length})\n${lines.join("\n")}`);
      },
    },
    {
      name: "kernel_travel_update_activity",
      description: "Update activity status or notes",
      inputSchema: z.object({
        id: z.string(),
        status: z.enum(["planned", "booked", "completed", "skipped"]).optional(),
        notes: z.string().optional(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as { id: string; [key: string]: unknown };
        const a = svc.updateActivity(id, changes as any);
        if (!a) return errorResult("Activity not found");
        return textResult(`Activity updated: **${a.title}** [${a.status}]`);
      },
    },

    // ── Expenses ───────────────────────────────────────────────────────────────
    {
      name: "kernel_travel_add_expense",
      description: "Log a travel expense",
      inputSchema: z.object({
        trip_id: z.string(),
        description: z.string(),
        amount_cents: z.number().describe("Amount in cents"),
        category: z.enum(["flight", "accommodation", "food", "transport", "activity", "shopping", "health", "other"]).optional().default("other"),
        currency: z.string().optional().default("EUR"),
        date: z.string().optional().describe("ISO date, default today"),
        payment_method: z.string().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        try {
          const e = svc.addExpense(args as any);
          return textResult(`Expense logged: ${e.description} — ${formatCents(e.amount_cents, e.currency)} [${e.category}]`);
        } catch (e2) {
          return errorResult(String(e2));
        }
      },
    },
    {
      name: "kernel_travel_budget",
      description: "Get budget summary for a trip (spent vs budget by category)",
      inputSchema: z.object({ trip_id: z.string() }),
      handler: async (args) => {
        const { trip_id } = args as { trip_id: string };
        const b = svc.getTripBudgetSummary(trip_id);
        const catLines = Object.entries(b.by_category).map(([k, v]) => `  - ${k}: ${formatCents(v)}`);
        const pct = b.budget_cents > 0 ? Math.round(b.total_spent_cents / b.budget_cents * 100) : 0;
        return textResult([
          `## Trip Budget`,
          `- Budget: ${formatCents(b.budget_cents)}`,
          `- Spent: ${formatCents(b.total_spent_cents)} (${pct}%)`,
          `- Remaining: ${formatCents(b.remaining_cents)}`,
          `\n**By Category:**`,
          ...catLines,
        ].join("\n"));
      },
    },

    // ── Packing ────────────────────────────────────────────────────────────────
    {
      name: "kernel_travel_add_packing_item",
      description: "Add an item to the trip packing list",
      inputSchema: z.object({
        trip_id: z.string(),
        name: z.string(),
        category: z.string().optional().default("general"),
        quantity: z.number().optional().default(1),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        try {
          const item = svc.addPackingItem(args as any);
          return textResult(`Packing item added: **${item.name}** [${item.category}]`);
        } catch (e) {
          return errorResult(String(e));
        }
      },
    },
    {
      name: "kernel_travel_packing_list",
      description: "Get the packing list for a trip",
      inputSchema: z.object({ trip_id: z.string() }),
      handler: async (args) => {
        const { trip_id } = args as { trip_id: string };
        const items = svc.listPackingItems(trip_id);
        if (!items.length) return textResult("No packing items.");
        const byCategory: Record<string, typeof items> = {};
        for (const item of items) {
          (byCategory[item.category] ??= []).push(item);
        }
        const lines: string[] = [];
        for (const [cat, catItems] of Object.entries(byCategory)) {
          lines.push(`\n**${cat}**`);
          for (const item of catItems) {
            lines.push(`  ${item.packed ? "☑" : "☐"} ${item.name} ×${item.quantity}`);
          }
        }
        const packed = items.filter(i => i.packed).length;
        return textResult(`## Packing List (${packed}/${items.length} packed)\n${lines.join("\n")}`);
      },
    },
    {
      name: "kernel_travel_toggle_packed",
      description: "Toggle packed/unpacked status of a packing item",
      inputSchema: z.object({ id: z.string() }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const item = svc.togglePacked(id);
        if (!item) return errorResult("Item not found");
        return textResult(`**${item.name}** marked as ${item.packed ? "packed ✓" : "unpacked"}`);
      },
    },

    // ── Documents ──────────────────────────────────────────────────────────────
    {
      name: "kernel_travel_add_document",
      description: "Store a travel document (passport, visa, insurance, etc.)",
      inputSchema: z.object({
        title: z.string(),
        type: z.enum(["passport", "visa", "insurance", "booking", "ticket", "other"]).optional().default("other"),
        number: z.string().optional(),
        trip_id: z.string().optional(),
        issued_at: z.string().optional().describe("ISO date"),
        expires_at: z.string().optional().describe("ISO date"),
        country: z.string().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        try {
          const doc = svc.addDocument(args as any);
          return textResult(`Document added: **${doc.title}** (${doc.type})${doc.expires_at ? ` expires ${doc.expires_at}` : ""}`);
        } catch (e) {
          return errorResult(String(e));
        }
      },
    },
    {
      name: "kernel_travel_expiring_documents",
      description: "Get travel documents expiring within N days",
      inputSchema: z.object({
        days: z.number().optional().default(90),
      }),
      handler: async (args) => {
        const { days } = args as { days?: number };
        const docs = svc.getExpiringDocuments(days ?? 90);
        if (!docs.length) return textResult(`No documents expiring in the next ${days ?? 90} days.`);
        const lines = docs.map(d =>
          `- **${d.title}** (${d.type}) — expires **${d.expires_at}**${d.country ? ` [${d.country}]` : ""}`
        );
        return textResult(`## Expiring Documents (next ${days ?? 90} days)\n${lines.join("\n")}`);
      },
    },
  ];
}

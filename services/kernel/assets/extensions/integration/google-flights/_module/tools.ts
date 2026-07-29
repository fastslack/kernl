import { z } from "zod";
import { errorResult, textResult } from "../../../../../src/core/helpers.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { GoogleFlightsService, SimpleSearchInput } from "./service.js";
import type { FlightLeg, FlightResult } from "./types.js";

const CABINS = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"] as const;
const STOPS = ["ANY", "NON_STOP", "ONE_STOP_OR_FEWER", "TWO_OR_FEWER_STOPS"] as const;
const SORT_BY = [
  "TOP_FLIGHTS",
  "BEST",
  "CHEAPEST",
  "DEPARTURE_TIME",
  "ARRIVAL_TIME",
  "DURATION",
  "EMISSIONS",
] as const;

export function googleFlightsTools(svc: GoogleFlightsService): ToolDefinition[] {
  return [
    {
      name: "kernel_google_flights_search",
      description:
        "Search live Google Flights fares for a route. Returns the top results sorted by the chosen criterion. " +
        "One-way by default; pass `return_date` for round-trip. IATA codes only.",
      inputSchema: z.object({
        origin: z.string().min(3).max(3).describe("3-letter IATA code, e.g. JFK, MAD, EZE"),
        destination: z.string().min(3).max(3).describe("3-letter IATA code"),
        depart_date: z.string().describe("Outbound date YYYY-MM-DD"),
        return_date: z.string().optional().describe("Return date YYYY-MM-DD (round-trip)"),
        adults: z.number().int().min(1).max(9).optional().default(1),
        children: z.number().int().min(0).max(8).optional(),
        infants_in_seat: z.number().int().min(0).max(4).optional(),
        infants_on_lap: z.number().int().min(0).max(4).optional(),
        cabin: z.enum(CABINS).optional().default("ECONOMY"),
        stops: z.enum(STOPS).optional().default("ANY"),
        airlines: z
          .array(z.string().min(2).max(3))
          .optional()
          .describe("Restrict results to these airline IATA codes (e.g. ['BA','IB'])"),
        sort_by: z.enum(SORT_BY).optional().default("BEST"),
        max_price: z.number().int().positive().optional().describe("Hard cap (in result currency)"),
        exclude_basic_economy: z.boolean().optional(),
        earliest_departure_hour: z.number().int().min(0).max(23).optional(),
        latest_departure_hour: z.number().int().min(0).max(23).optional(),
        top_n: z.number().int().min(1).max(50).optional().default(10),
      }),
      handler: async (args) => {
        const input = args as SimpleSearchInput & { top_n?: number };
        try {
          const out = await svc.search(input);
          if (out.flights.length === 0) {
            return textResult(
              `No flights found for **${input.origin} → ${input.destination}** on ${input.depart_date}.`,
            );
          }
          const top = out.flights.slice(0, input.top_n ?? 10);
          return textResult(formatFlightsMarkdown(input, top, out.flights.length, out.duration_ms));
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      name: "kernel_google_flights_cheapest",
      description:
        "Shortcut: find the single cheapest flight for a route on a given date. Returns price, airline, and duration.",
      inputSchema: z.object({
        origin: z.string().min(3).max(3),
        destination: z.string().min(3).max(3),
        depart_date: z.string().describe("YYYY-MM-DD"),
        return_date: z.string().optional(),
        adults: z.number().int().min(1).max(9).optional().default(1),
        cabin: z.enum(CABINS).optional().default("ECONOMY"),
      }),
      handler: async (args) => {
        const input = args as SimpleSearchInput;
        try {
          const out = await svc.search({ ...input, sort_by: "CHEAPEST" });
          if (out.flights.length === 0) {
            return textResult(`No flights found for ${input.origin} → ${input.destination}.`);
          }
          const f = out.flights[0];
          const lines = [
            `## Cheapest: ${input.origin} → ${input.destination}`,
            `- **Price**: ${formatPrice(f.price, f.currency)}`,
            `- **Total duration**: ${formatDuration(f.duration)}`,
            `- **Stops**: ${f.stops}`,
            `- **Carrier(s)**: ${uniqueAirlines(f.legs).join(", ")}`,
            `- **Depart**: ${f.legs[0].departure_datetime} (${f.legs[0].departure_airport})`,
            `- **Arrive**: ${f.legs[f.legs.length - 1].arrival_datetime} (${f.legs[f.legs.length - 1].arrival_airport})`,
          ];
          return textResult(lines.join("\n"));
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      name: "kernel_google_flights_recent",
      description:
        "List the most recent searches this kernel has run against Google Flights. Useful for debugging or audit.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().default(20),
      }),
      handler: async (args) => {
        const { limit } = args as { limit?: number };
        const rows = svc.recentSearches(limit ?? 20);
        if (rows.length === 0) return textResult("No searches recorded yet.");
        const lines = rows.map((r) => {
          const route = `${r.origin} → ${r.destination}`;
          const date = String(r.depart_date) + (r.return_date ? ` ↔ ${r.return_date}` : "");
          const status = r.error ? `❌ ${r.error}` : `${r.result_count} results`;
          return `- ${r.created_at} · **${route}** · ${date} · ${status} · ${r.duration_ms}ms`;
        });
        return textResult(`## Recent flight searches\n${lines.join("\n")}`);
      },
    },
  ];
}

function formatFlightsMarkdown(
  input: SimpleSearchInput,
  flights: FlightResult[],
  totalCount: number,
  durationMs: number,
): string {
  const header =
    `## Flights ${input.origin} → ${input.destination}` +
    `${input.return_date ? ` ↔ ${input.return_date}` : ""}` +
    ` · ${input.depart_date}` +
    ` · ${flights.length}/${totalCount} results · ${durationMs}ms`;

  const rows = flights.map((f, i) => {
    const carriers = uniqueAirlines(f.legs).join("/");
    const flightNumbers = f.legs.map((l) => `${l.airline}${l.flight_number}`).join(" → ");
    const dep = f.legs[0];
    const arr = f.legs[f.legs.length - 1];
    return [
      `### ${i + 1}. ${formatPrice(f.price, f.currency)} · ${carriers} · ${formatDuration(f.duration)} · ${stopsLabel(f.stops)}`,
      `- ${dep.departure_airport} ${dep.departure_datetime} → ${arr.arrival_airport} ${arr.arrival_datetime}`,
      `- ${flightNumbers}`,
    ].join("\n");
  });
  return `${header}\n\n${rows.join("\n\n")}`;
}

function uniqueAirlines(legs: FlightLeg[]): string[] {
  return Array.from(new Set(legs.map((l) => l.airline)));
}

function formatPrice(price: number, currency: string | null): string {
  if (price <= 0) return "n/a";
  const code = currency ?? "USD";
  return `${code} ${price.toFixed(2)}`;
}

function formatDuration(minutes: number): string {
  if (!minutes || minutes <= 0) return "?";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function stopsLabel(n: number): string {
  if (n === 0) return "non-stop";
  if (n === 1) return "1 stop";
  return `${n} stops`;
}

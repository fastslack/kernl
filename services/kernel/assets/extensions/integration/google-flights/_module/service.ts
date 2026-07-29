/**
 * GoogleFlightsService — drives Google Flights' internal API to search
 * for real fares. Direct port of the network layer in
 * https://github.com/punitarani/fli (Python).
 *
 * IMPORTANT: this is the unofficial endpoint Google's web UI uses. It
 * has no SLA and rate limits are unpublished. The kernel hits it on
 * demand from agent tools, with a small persisted log of every search
 * (`google_flights_searches`) so abuse is observable.
 */

import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { encodeFilters } from "./encoder.js";
import { parseSearchResponse } from "./parser.js";
import {
  type FlightResult,
  type FlightSearchFilters,
  type FlightSegment,
  type PassengerInfo,
  MaxStops,
  SeatType,
  SortBy,
  TripType,
} from "./types.js";

const ENDPOINT =
  "https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults";

const DEFAULT_HEADERS: Record<string, string> = {
  "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  "x-same-domain": "1",
  origin: "https://www.google.com",
  referer: "https://www.google.com/travel/flights",
};

export interface SimpleSearchInput {
  origin: string;            // IATA code, e.g. "JFK"
  destination: string;       // IATA code
  depart_date: string;       // YYYY-MM-DD
  return_date?: string;      // YYYY-MM-DD — present ⇒ round-trip
  adults?: number;
  children?: number;
  infants_in_seat?: number;
  infants_on_lap?: number;
  cabin?: keyof typeof SeatType;
  stops?: keyof typeof MaxStops;
  airlines?: string[];
  sort_by?: keyof typeof SortBy;
  max_price?: number;
  exclude_basic_economy?: boolean;
  earliest_departure_hour?: number;
  latest_departure_hour?: number;
}

export interface SearchOutcome {
  flights: FlightResult[];
  duration_ms: number;
  cached: boolean;
}

export class GoogleFlightsService {
  constructor(private db: SqliteDb) {}

  /** Run a search using the simplified flat input agents will use. */
  async search(input: SimpleSearchInput): Promise<SearchOutcome> {
    const filters = this.buildFilters(input);
    return this.searchWithFilters(filters, input);
  }

  /** Lower-level: run with a fully-formed `FlightSearchFilters` object. */
  async searchWithFilters(
    filters: FlightSearchFilters,
    logCtx?: SimpleSearchInput,
  ): Promise<SearchOutcome> {
    const started = Date.now();
    let flights: FlightResult[] = [];
    let errorMsg = "";
    try {
      const body = `f.req=${encodeFilters(filters)}`;
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: DEFAULT_HEADERS,
        body,
        redirect: "follow",
      });
      if (!res.ok) {
        throw new Error(`Google Flights HTTP ${res.status}: ${await safeText(res)}`);
      }
      const text = await res.text();
      flights = parseSearchResponse(text);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      log.warn(`google-flights: search failed — ${errorMsg}`);
    }
    const duration = Date.now() - started;

    if (logCtx) this.logSearch(logCtx, flights, duration, errorMsg);

    if (errorMsg) throw new Error(errorMsg);
    return { flights, duration_ms: duration, cached: false };
  }

  /**
   * Build a `FlightSearchFilters` from the agent-friendly flat input.
   * One-way if `return_date` is omitted; round-trip otherwise. Multi-city
   * is supported only by callers that go through `searchWithFilters`
   * directly.
   */
  buildFilters(input: SimpleSearchInput): FlightSearchFilters {
    const segments: FlightSegment[] = [
      {
        departure_airport: [[input.origin.toUpperCase(), 0]],
        arrival_airport: [[input.destination.toUpperCase(), 0]],
        travel_date: input.depart_date,
        time_restrictions: this.timeRestrictions(input),
      },
    ];
    if (input.return_date) {
      segments.push({
        departure_airport: [[input.destination.toUpperCase(), 0]],
        arrival_airport: [[input.origin.toUpperCase(), 0]],
        travel_date: input.return_date,
      });
    }

    const passenger_info: PassengerInfo = {
      adults: input.adults ?? 1,
      children: input.children ?? 0,
      infants_in_seat: input.infants_in_seat ?? 0,
      infants_on_lap: input.infants_on_lap ?? 0,
    };

    return {
      trip_type: input.return_date ? TripType.ROUND_TRIP : TripType.ONE_WAY,
      passenger_info,
      flight_segments: segments,
      stops: input.stops ? MaxStops[input.stops] : MaxStops.ANY,
      seat_type: input.cabin ? SeatType[input.cabin] : SeatType.ECONOMY,
      airlines: input.airlines && input.airlines.length > 0 ? input.airlines : undefined,
      price_limit: input.max_price ? { max_price: input.max_price } : undefined,
      sort_by: input.sort_by ? SortBy[input.sort_by] : SortBy.BEST,
      exclude_basic_economy: !!input.exclude_basic_economy,
    };
  }

  private timeRestrictions(input: SimpleSearchInput) {
    if (input.earliest_departure_hour == null && input.latest_departure_hour == null) {
      return undefined;
    }
    return {
      earliest_departure: input.earliest_departure_hour,
      latest_departure: input.latest_departure_hour,
    };
  }

  private logSearch(
    ctx: SimpleSearchInput,
    flights: FlightResult[],
    duration: number,
    errorMsg: string,
  ): void {
    const cheapest = flights.reduce(
      (acc, f) => (acc === null || f.price < acc.price ? f : acc),
      null as FlightResult | null,
    );
    this.db
      .prepare(
        `INSERT INTO google_flights_searches
         (id, origin, destination, depart_date, return_date, adults, cabin,
          result_count, cheapest_cents, currency, duration_ms, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        ctx.origin.toUpperCase(),
        ctx.destination.toUpperCase(),
        ctx.depart_date,
        ctx.return_date ?? "",
        ctx.adults ?? 1,
        ctx.cabin ?? "ECONOMY",
        flights.length,
        cheapest ? Math.round(cheapest.price * 100) : 0,
        cheapest?.currency ?? "",
        duration,
        errorMsg,
        isoNow(),
      );
  }

  /** Recent search history (most recent first). */
  recentSearches(limit = 20): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT * FROM google_flights_searches ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit);
    return rows as Array<Record<string, unknown>>;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return "";
  }
}

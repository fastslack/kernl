/**
 * Types for Google Flights search — port of `punitarani/fli` (Python).
 *
 * Wire-format note: enum *values* match what Google Flights' internal API
 * expects, so don't re-number these. They are derived from
 * `fli/models/google_flights/base.py` upstream.
 */

export const SeatType = {
  ECONOMY: 1,
  PREMIUM_ECONOMY: 2,
  BUSINESS: 3,
  FIRST: 4,
} as const;
export type SeatType = (typeof SeatType)[keyof typeof SeatType];

export const SortBy = {
  TOP_FLIGHTS: 0,
  BEST: 1,
  CHEAPEST: 2,
  DEPARTURE_TIME: 3,
  ARRIVAL_TIME: 4,
  DURATION: 5,
  EMISSIONS: 6,
} as const;
export type SortBy = (typeof SortBy)[keyof typeof SortBy];

export const TripType = {
  ROUND_TRIP: 1,
  ONE_WAY: 2,
  MULTI_CITY: 3,
} as const;
export type TripType = (typeof TripType)[keyof typeof TripType];

export const MaxStops = {
  ANY: 0,
  NON_STOP: 1,
  ONE_STOP_OR_FEWER: 2,
  TWO_OR_FEWER_STOPS: 3,
} as const;
export type MaxStops = (typeof MaxStops)[keyof typeof MaxStops];

export const EmissionsFilter = {
  ALL: 0,
  LESS: 1,
} as const;
export type EmissionsFilter = (typeof EmissionsFilter)[keyof typeof EmissionsFilter];

export interface BagsFilter {
  checked_bags?: number;
  carry_on?: boolean;
}

export interface TimeRestrictions {
  earliest_departure?: number;
  latest_departure?: number;
  earliest_arrival?: number;
  latest_arrival?: number;
}

export interface PassengerInfo {
  adults?: number;
  children?: number;
  infants_in_seat?: number;
  infants_on_lap?: number;
}

export interface PriceLimit {
  max_price: number;
  currency?: string;
}

export interface LayoverRestrictions {
  airports?: string[];
  max_duration?: number;
}

/**
 * Single segment of a journey. `departure_airport` and `arrival_airport`
 * use the nested format Google expects: list of `[IATA, weight]` pairs
 * where `weight` is 0 (origin/destination) or 1 (alternate). Most callers
 * will just pass `[["JFK", 0]]`.
 */
export interface FlightSegment {
  departure_airport: Array<[string, number]>;
  arrival_airport: Array<[string, number]>;
  travel_date: string; // YYYY-MM-DD
  time_restrictions?: TimeRestrictions;
  selected_flight?: FlightResult;
}

export interface FlightLeg {
  airline: string; // IATA code
  flight_number: string;
  departure_airport: string;
  arrival_airport: string;
  departure_datetime: string; // ISO 8601
  arrival_datetime: string;
  duration: number; // minutes
}

export interface FlightResult {
  legs: FlightLeg[];
  price: number;
  currency: string | null;
  duration: number; // total minutes
  stops: number;
}

export interface FlightSearchFilters {
  trip_type?: TripType;
  passenger_info: PassengerInfo;
  flight_segments: FlightSegment[];
  stops?: MaxStops;
  seat_type?: SeatType;
  price_limit?: PriceLimit;
  airlines?: string[]; // IATA codes
  max_duration?: number;
  layover_restrictions?: LayoverRestrictions;
  sort_by?: SortBy;
  exclude_basic_economy?: boolean;
  emissions?: EmissionsFilter;
  bags?: BagsFilter;
  show_all_results?: boolean;
}

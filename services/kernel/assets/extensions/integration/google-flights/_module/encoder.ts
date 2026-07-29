/**
 * Encode FlightSearchFilters into the deeply-nested array structure that
 * Google Flights' internal API expects, then URL-encode it for the
 * `f.req=` POST body.
 *
 * Direct port of `FlightSearchFilters.format()` + `.encode()` from
 * https://github.com/punitarani/fli (Python). The index map and "seemingly
 * no effect" comments are preserved verbatim from upstream — those slots
 * matter even if they look inert (Google rejects scalar values in some).
 */

import {
  type FlightSearchFilters,
  TripType,
  EmissionsFilter,
  MaxStops,
  SeatType,
  SortBy,
} from "./types.js";

export function formatFilters(f: FlightSearchFilters): unknown[] {
  const tripType = f.trip_type ?? TripType.ONE_WAY;
  const seatType = f.seat_type ?? SeatType.ECONOMY;
  const stops = f.stops ?? MaxStops.ANY;
  const sortBy = f.sort_by ?? SortBy.BEST;
  const emissions = f.emissions ?? EmissionsFilter.ALL;
  const showAll = f.show_all_results ?? true;
  const passengers = f.passenger_info;

  const formattedSegments: unknown[] = [];
  for (const segment of f.flight_segments) {
    const segmentFilters: unknown[][] = [
      [segment.departure_airport.map((p) => [p[0], p[1]])],
      [segment.arrival_airport.map((p) => [p[0], p[1]])],
    ];

    let timeFilters: (number | null | undefined)[] | null = null;
    if (segment.time_restrictions) {
      timeFilters = [
        segment.time_restrictions.earliest_departure ?? null,
        segment.time_restrictions.latest_departure ?? null,
        segment.time_restrictions.earliest_arrival ?? null,
        segment.time_restrictions.latest_arrival ?? null,
      ];
    }

    let airlinesFilters: string[] | null = null;
    if (f.airlines && f.airlines.length > 0) {
      airlinesFilters = [...f.airlines].sort();
    }

    const layoverAirports =
      f.layover_restrictions?.airports && f.layover_restrictions.airports.length > 0
        ? f.layover_restrictions.airports
        : null;
    const layoverDuration = f.layover_restrictions?.max_duration ?? null;

    let selectedFlights: unknown[] | null = null;
    const isMultiLeg = tripType === TripType.ROUND_TRIP || tripType === TripType.MULTI_CITY;
    if (isMultiLeg && segment.selected_flight) {
      selectedFlights = segment.selected_flight.legs.map((leg) => [
        leg.departure_airport,
        leg.departure_datetime.slice(0, 10), // YYYY-MM-DD
        leg.arrival_airport,
        null,
        leg.airline,
        leg.flight_number,
      ]);
    }

    const emissionsFilter = emissions !== EmissionsFilter.ALL ? [emissions] : null;

    formattedSegments.push([
      segmentFilters[0],                   // 0: departure airports
      segmentFilters[1],                   // 1: arrival airports
      timeFilters,                         // 2: time restrictions
      stops,                               // 3: stops
      airlinesFilters,                     // 4: airlines
      null,                                // 5: unknown — accepts [] but 400s on scalars
      segment.travel_date,                 // 6: travel date
      f.max_duration ? [f.max_duration] : null, // 7: max duration
      selectedFlights,                     // 8: selected flight (return-leg fetch)
      layoverAirports,                     // 9: layover airports
      null,                                // 10: unknown — same shape rule as 5
      null,                                // 11: seemingly no effect
      layoverDuration,                     // 12: layover duration
      emissionsFilter,                     // 13: emissions filter ([1] = less)
      3,                                   // 14: seemingly no effect (hardcoded)
    ]);
  }

  const bagsFilter = f.bags
    ? [f.bags.checked_bags ?? 0, f.bags.carry_on ? 1 : 0]
    : null;

  // The browser uses a wrapper format with self-transfer at [6] and
  // basic-economy at [15], but it returns empty results through
  // non-browser clients (cookie/header dependent). The flat format below
  // is what the bare API endpoint accepts. Self-transfer cannot be
  // toggled in the flat format — that's an upstream limitation.
  //
  // Index map for filters[1] (preserved from upstream comments):
  //   2: trip type
  //   5: seat/cabin type
  //   6: passenger counts [adults, children, infants_lap, infants_seat]
  //   7: price limit [None, max_price]
  //   10: bags filter [checked_bags, carry_on]
  //   13: flight segments
  //   28: exclude basic economy (0=allow, 1=exclude)
  //   others: unknown — pass through as null
  const filtersOuter: unknown[] = [
    [], // outer[0]
    [
      null,                                // [0] seemingly no effect
      null,                                // [1] seemingly no effect (not currency)
      tripType,                            // [2] trip type
      null,                                // [3] seemingly no effect
      [],                                  // [4] seemingly no effect
      seatType,                            // [5] cabin
      [
        passengers.adults ?? 1,
        passengers.children ?? 0,
        passengers.infants_on_lap ?? 0,
        passengers.infants_in_seat ?? 0,
      ],                                   // [6] passenger counts
      f.price_limit ? [null, f.price_limit.max_price] : null, // [7] price limit
      null,                                // [8]
      null,                                // [9]
      bagsFilter,                          // [10] bags filter
      null,                                // [11]
      null,                                // [12]
      formattedSegments,                   // [13] flight segments
      null,                                // [14]
      null,                                // [15]
      null,                                // [16]
      1,                                   // [17] seemingly no effect (hardcoded)
      null, null, null, null, null, null, null, null, null, null, // [18..27]
      f.exclude_basic_economy ? 1 : 0,    // [28]
    ],
    sortBy,                                // outer[2] sort mode
    showAll ? 1 : 0,                       // outer[3] 0 = ~30, 1 = all
    0,                                     // outer[4]
    1,                                     // outer[5]
  ];

  return filtersOuter;
}

/** URL-encode the formatted filters for the `f.req=` POST body. */
export function encodeFilters(f: FlightSearchFilters): string {
  const formatted = formatFilters(f);
  const inner = JSON.stringify(formatted);
  const wrapped = JSON.stringify([null, inner]);
  return encodeURIComponent(wrapped);
}

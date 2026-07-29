#!/usr/bin/env tsx
/**
 * Real-world smoke test for the google-flights module.
 *
 *   npx tsx scripts/demo-google-flights.ts MAD EZE 2026-09-15 [2026-10-01]
 *
 * Defaults to MAD → EZE one-way ~30 days out so it works without args.
 * Hits Google's real endpoint — don't run in tight loops.
 */

import Database from "better-sqlite3";
import { runMigrations } from "../src/core/db/migrations.js";
import { googleFlightsMigrations } from "../assets/extensions/integration/google-flights/_module/migrations.js";
import { GoogleFlightsService } from "../assets/extensions/integration/google-flights/_module/service.js";

function defaultDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const [origin = "MAD", destination = "EZE", depart = defaultDate(30), ret] = process.argv.slice(2);

  const db = new Database(":memory:");
  runMigrations(db, "google-flights", googleFlightsMigrations);
  const svc = new GoogleFlightsService(db);

  console.log(`Searching ${origin} → ${destination} on ${depart}${ret ? ` ↔ ${ret}` : ""}`);
  const result = await svc.search({
    origin,
    destination,
    depart_date: depart,
    return_date: ret,
    adults: 1,
    cabin: "ECONOMY",
    sort_by: "CHEAPEST",
  });

  console.log(`Got ${result.flights.length} flights in ${result.duration_ms}ms`);
  for (const f of result.flights.slice(0, 5)) {
    const carriers = Array.from(new Set(f.legs.map((l) => l.airline))).join("/");
    const dep = f.legs[0];
    const arr = f.legs[f.legs.length - 1];
    const price = f.price > 0 ? `${f.currency ?? "USD"} ${f.price.toFixed(2)}` : "n/a";
    console.log(
      `  ${price.padEnd(12)} · ${carriers.padEnd(8)} · ${String(f.duration).padEnd(4)}min · ` +
        `${f.stops} stops · ${dep.departure_airport} ${dep.departure_datetime} → ${arr.arrival_airport} ${arr.arrival_datetime}`,
    );
  }

  console.log("\nRecent searches:");
  for (const r of svc.recentSearches(5)) {
    console.log(`  ${r.created_at} · ${r.origin} → ${r.destination} · ${r.result_count} results · ${r.duration_ms}ms`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

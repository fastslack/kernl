/**
 * places module — where things are, and what is near (service.ts).
 *
 *   * `kernel_places_near` — events, hotels, activities and trips around a
 *     point, a map link, a known place or (with the geocoder on) an address.
 *   * `kernel_places_set`  — coordinates by hand for an item or a place of your own.
 *   * `kernel_places_sync` — re-read the sources, geocode what is missing.
 *   * `kernel_places_list` — what is known, or what still has no coordinates.
 *
 * Coordinates come from map links in the items themselves. Turning an address
 * into coordinates needs a geocoder, which sends the address out of the
 * machine: it stays off unless PLACES_GEOCODER=nominatim (NOMINATIM_URL points
 * at your own instance).
 */
import { z } from "zod";
import type { KernelModule, ModuleContext, ToolDefinition, ToolResult } from "../../core/types.js";
import { errorResult, structuredResult } from "../../core/helpers.js";
import { runMigrations } from "../../core/db/migrations.js";
import { defineTool } from "../../core/tool-builder.js";
import { log } from "../../core/logger.js";
import { placesMigrations } from "./migrations.js";
import { PlacesService } from "./service.js";
import { nominatimGeocoder, parseCoordinates } from "./geo.js";

const KINDS = ["event", "trip", "accommodation", "activity", "manual"] as const;
const cost = { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 10, reversible: true, cacheable: false };

export function createPlacesModule(): KernelModule {
  let service: PlacesService | null = null;
  let lastSync = 0;
  const fresh = async () => {
    // Offline part only (no geocoding) and at most once a minute: cheap enough to run before a read.
    if (service && Date.now() - lastSync > 60_000) {
      lastSync = Date.now();
      await service.sync({ geocodeLimit: 0 });
    }
  };

  const tools: ToolDefinition[] = [
    defineTool({
      name: "kernel_places_near",
      description:
        "What is near a place: events, trips, hotels and travel activities within a radius, nearest first, with the distance in km. " +
        "`where` is coordinates (\"-34.60, -58.38\"), a map link, the name or address of a known place, or — when the geocoder is on — any address. " +
        "Items only count once they have coordinates (from a map link, set by hand, or geocoded); `kernel_places_list` with missing=true shows the rest.",
      schema: z.object({
        where: z.string().min(1),
        radius_km: z.number().positive().max(20000).default(5),
        kinds: z.array(z.enum(KINDS)).optional(),
        from: z.string().optional().describe("Only items on or after this date (ISO)."),
        to: z.string().optional().describe("Only items on or before this date (ISO)."),
        limit: z.number().int().positive().max(200).default(20),
      }),
      outputSchema: z.unknown(),
      tags: ["places", "geo"],
      cost,
      async handler(a): Promise<ToolResult> {
        if (!service) return errorResult("places not available");
        await fresh();
        const center = await service.resolve(a.where);
        if (!center) {
          return errorResult(
            `Could not place "${a.where}". Give coordinates or a map link, name a place that already has coordinates` +
              (service.geocoding ? ", or a more complete address." : " (turning addresses into coordinates is off: PLACES_GEOCODER=nominatim)."),
          );
        }
        const items = service.near(center, { radiusKm: a.radius_km, kinds: a.kinds, from: a.from, to: a.to, limit: a.limit });
        return structuredResult({ center, radius_km: a.radius_km, items });
      },
    }),
    defineTool({
      name: "kernel_places_set",
      description:
        "Set where something is, by hand. For an item: kind + ref_id (an event, trip, accommodation or activity id). " +
        "For a place of your own (home, office, a gym): kind 'manual' with a name. Takes lat/lng or a map link; a hand-set place is never overwritten by a sync.",
      schema: z.object({
        kind: z.enum(KINDS),
        ref_id: z.string().optional().describe("The item's id; leave out for a new place of your own."),
        name: z.string().optional(),
        address: z.string().optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        link: z.string().optional().describe("A map link or \"lat, lng\" instead of lat/lng."),
      }),
      outputSchema: z.unknown(),
      tags: ["places", "geo"],
      cost,
      async handler(a): Promise<ToolResult> {
        if (!service) return errorResult("places not available");
        const at = a.lat !== undefined && a.lng !== undefined ? { lat: a.lat, lng: a.lng } : parseCoordinates(a.link ?? "");
        if (!at) return errorResult("Give lat and lng, or a map link that carries coordinates.");
        if (a.kind !== "manual" && !a.ref_id) return errorResult("ref_id is required for an item; use kind 'manual' for a place of your own.");
        if (a.kind === "manual" && !a.ref_id && !a.name) return errorResult("A place of your own needs a name.");
        return structuredResult({ place: await service.set({ kind: a.kind, ref_id: a.ref_id, name: a.name, text: a.address, ...at }) });
      },
    }),
    defineTool({
      name: "kernel_places_sync",
      description:
        "Re-read events and travel for places, take coordinates from their map links and — when the geocoder is on — look up up to `geocode` addresses that still have none.",
      schema: z.object({ geocode: z.number().int().min(0).max(200).default(20) }),
      outputSchema: z.unknown(),
      tags: ["places", "geo"],
      cost: { ...cost, latency_p50_ms: 200 },
      async handler(a): Promise<ToolResult> {
        if (!service) return errorResult("places not available");
        lastSync = Date.now();
        const r = await service.sync({ geocodeLimit: a.geocode });
        return structuredResult({ ...r, geocoder: service.geocoding ? "on" : "off (PLACES_GEOCODER=nominatim to turn it on)" });
      },
    }),
    defineTool({
      name: "kernel_places_list",
      description: "Known places, newest first. `missing: true` lists items that name a place but have no coordinates yet.",
      schema: z.object({
        kind: z.enum(KINDS).optional(),
        missing: z.boolean().default(false),
        limit: z.number().int().positive().max(500).default(50),
      }),
      outputSchema: z.unknown(),
      tags: ["places", "geo"],
      cost,
      async handler(a): Promise<ToolResult> {
        if (!service) return errorResult("places not available");
        await fresh();
        return structuredResult({ places: service.list({ kind: a.kind, missing: a.missing, limit: a.limit }) });
      },
    }),
  ];

  return {
    name: "places",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "places", placesMigrations);
      const geocoder = process.env.PLACES_GEOCODER === "nominatim" ? nominatimGeocoder({ baseUrl: process.env.NOMINATIM_URL }) : null;
      service = new PlacesService(ctx.sqlite, () => ctx.graph, geocoder);
      await service.ensureSchema().catch((e) => log.warn(`places: graph schema: ${(e as Error).message}`));
      // Extensions migrate their tables after the core modules: read the sources once everything is up.
      setTimeout(() => {
        lastSync = Date.now();
        service?.sync({ geocodeLimit: 0 }).catch((e) => log.warn(`places: first sync failed: ${(e as Error).message}`));
      }, 15_000).unref?.();
    },
    getTools(): ToolDefinition[] {
      return tools;
    },
    getGraphBackfill() {
      const s = service;
      return s ? { name: "places", version: 1, order: 60, run: () => s.graphBackfill() } : undefined;
    },
    async shutdown() {
      service = null;
    },
  };
}

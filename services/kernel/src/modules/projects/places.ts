/**
 * Business search on Google Maps (Places API (New) Text Search), for offices
 * that prospect — Sales looks for "clínicas en Córdoba". Read-only: it is not
 * an outbound tool, so project runs can use it.
 *
 * The key is the GOOGLE_PLACES_API_KEY setting (Ajustes → Integraciones).
 * A per-kernel rate limit keeps a looping agent from burning the quota.
 */
import { z } from "zod";
import { defineTool } from "../../core/tool-builder.js";
import { textResult, errorResult } from "../../core/helpers.js";
import type { ToolDefinition } from "../../core/types.js";

export interface Place {
  place_id: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  rating: number | null;
  reviews: number;
  maps_url: string;
  types: string[];
}

export interface PlacesDeps {
  apiKey: () => string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id", "places.displayName", "places.formattedAddress", "places.nationalPhoneNumber",
  "places.internationalPhoneNumber", "places.websiteUri", "places.rating", "places.userRatingCount",
  "places.googleMapsUri", "places.types", "nextPageToken",
].join(",");
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

let calls: number[] = [];

/** Tests only: forget past searches. */
export function resetPlacesRateLimit(): void {
  calls = [];
}

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  types?: string[];
}

const toPlace = (p: RawPlace): Place => ({
  place_id: p.id ?? "",
  name: p.displayName?.text ?? "",
  address: p.formattedAddress ?? "",
  phone: p.nationalPhoneNumber ?? p.internationalPhoneNumber ?? "",
  website: p.websiteUri ?? "",
  rating: typeof p.rating === "number" ? p.rating : null,
  reviews: p.userRatingCount ?? 0,
  maps_url: p.googleMapsUri ?? "",
  types: p.types ?? [],
});

export async function placesSearch(
  input: { query: string; location?: string; radius_km?: number; limit?: number },
  deps: PlacesDeps,
): Promise<{ ok: true; places: Place[] } | { ok: false; error: string }> {
  const key = deps.apiKey().trim();
  if (!key) return { ok: false, error: "Configurá la clave de Google Places en Ajustes → Integraciones." };
  const now = (deps.now ?? Date.now)();
  calls = calls.filter((t) => now - t < WINDOW_MS);
  if (calls.length >= MAX_PER_WINDOW) {
    return { ok: false, error: "Demasiadas búsquedas en el último minuto. Esperá un momento y probá de nuevo." };
  }
  calls.push(now);

  const limit = Math.min(Math.max(1, input.limit ?? 20), 60);
  const textQuery = input.location?.trim() ? `${input.query.trim()} en ${input.location.trim()}` : input.query.trim();
  const fetchFn = deps.fetchFn ?? fetch;
  const places: Place[] = [];
  let pageToken: string | undefined;
  do {
    let res: Response;
    try {
      res = await fetchFn(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify({ textQuery, pageSize: Math.min(20, limit - places.length), ...(pageToken ? { pageToken } : {}) }),
      signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return { ok: false, error: `No pude contactar a Google Places (${err instanceof Error ? err.message : String(err)}). Probá de nuevo en un rato.` };
    }
    const json = (await res.json().catch(() => ({}))) as { places?: RawPlace[]; nextPageToken?: string; error?: { message?: string } };
    if (!res.ok) return { ok: false, error: `Google Places respondió ${res.status}: ${json.error?.message ?? "error"}` };
    for (const p of json.places ?? []) {
      if (places.length < limit) places.push(toPlace(p));
    }
    pageToken = json.nextPageToken;
  } while (pageToken && places.length < limit);
  return { ok: true, places };
}

export function placesTool(deps: PlacesDeps): ToolDefinition {
  return defineTool({
    name: "kernel_places_search",
    description:
      "Search businesses on Google Maps by kind and place (e.g. query 'clínicas', location 'Córdoba, Argentina'). " +
      "Returns name, address, phone, website, rating and a Maps link. Read-only; up to 60 results.",
    schema: z.object({
      query: z.string().min(2).describe("What to look for, e.g. 'clínicas', 'estudios contables'"),
      location: z.string().optional().describe("City or area, e.g. 'Córdoba, Argentina'"),
      radius_km: z.number().max(50).optional().describe("Not used by text search yet; keep the location precise instead"),
      limit: z.number().int().min(1).max(60).optional().describe("Max results (default 20)"),
    }),
    handler: async (input) => {
      const r = await placesSearch(input, deps);
      if (!r.ok) return errorResult(r.error);
      if (r.places.length === 0) return textResult("Sin resultados.");
      const lines = r.places.map((p) =>
        `- **${p.name}** — ${p.address}` +
        (p.phone ? ` · ${p.phone}` : "") +
        (p.website ? ` · ${p.website}` : "") +
        (p.rating !== null ? ` · ★${p.rating} (${p.reviews})` : "") +
        ` · ${p.maps_url} · place_id ${p.place_id}`,
      );
      return { ...textResult(lines.join("\n")), structuredContent: { places: r.places } };
    },
  });
}

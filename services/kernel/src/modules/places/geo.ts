/**
 * Coordinates without a network: what a map link or a pasted "lat, lng" says,
 * and the distance between two points.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const valid = (lat: number, lng: number): LatLng | null =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)
    ? { lat, lng }
    : null;

const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";

/**
 * Coordinates from a Google Maps / OpenStreetMap / Apple Maps link, a `geo:` URI,
 * or plain "-34.6037, -58.3816". Returns null when the text has none.
 *
 * The order matters: a Google place link carries the camera (`@lat,lng`) and the
 * pin (`!3dlat!4dlng`); the pin is the place.
 */
export function parseCoordinates(text: string): LatLng | null {
  if (!text) return null;
  const s = decodeURIComponent(text.replace(/\+/g, " "));
  const patterns: RegExp[] = [
    new RegExp(`!3d${NUM}!4d${NUM}`),
    new RegExp(`[?&](?:q|query|ll|destination|daddr|center|mlat)=${NUM}\\s*,\\s*${NUM}`),
    new RegExp(`@${NUM},${NUM}(?:,|$|z)`),
    new RegExp(`#map=\\d+/${NUM}/${NUM}`),
    new RegExp(`^geo:${NUM},${NUM}`),
    new RegExp(`^\\s*${NUM}\\s*,\\s*${NUM}\\s*$`),
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const p = valid(Number(m[1]), Number(m[2]));
      if (p) return p;
    }
  }
  // OpenStreetMap: ?mlat=..&mlon=..
  const osm = s.match(new RegExp(`mlat=${NUM}.*?mlon=${NUM}`));
  if (osm) return valid(Number(osm[1]), Number(osm[2]));
  return null;
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371.0088;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A box around a point, for a cheap SQL prefilter before the exact distance. */
export function boundingBox(c: LatLng, km: number): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const dLat = km / 111.32;
  const cos = Math.max(0.01, Math.cos((c.lat * Math.PI) / 180));
  const dLng = Math.min(180, km / (111.32 * cos));
  return { minLat: c.lat - dLat, maxLat: c.lat + dLat, minLng: c.lng - dLng, maxLng: c.lng + dLng };
}

export type Geocoder = (text: string) => Promise<(LatLng & { label?: string }) | null>;

/**
 * OpenStreetMap's Nominatim. It sends the address text to that server, so it
 * is only built when the operator turned it on (PLACES_GEOCODER=nominatim).
 * Its usage policy asks for at most one request a second and an identifying
 * User-Agent; both are kept here.
 */
export function nominatimGeocoder(opts: { baseUrl?: string; fetchImpl?: typeof fetch; minIntervalMs?: number } = {}): Geocoder {
  const base = (opts.baseUrl || "https://nominatim.openstreetmap.org").replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const gap = opts.minIntervalMs ?? 1100;
  let last = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return (text: string) => {
    const run = async () => {
      const wait = last + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const url = `${base}/search?format=jsonv2&limit=1&q=${encodeURIComponent(text)}`;
      const res = await f(url, { headers: { "User-Agent": "Kernl/1 (personal assistant)", Accept: "application/json" } });
      if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
      const rows = (await res.json()) as Array<{ lat: string; lon: string; display_name?: string }>;
      const hit = rows[0];
      if (!hit) return null;
      const p = valid(Number(hit.lat), Number(hit.lon));
      return p ? { ...p, label: hit.display_name } : null;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  };
}

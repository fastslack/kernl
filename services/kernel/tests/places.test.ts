import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { placesMigrations } from "../src/modules/places/migrations.js";
import { PlacesService } from "../src/modules/places/service.js";
import { distanceKm, nominatimGeocoder, parseCoordinates } from "../src/modules/places/geo.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";

describe("coordinates from text", () => {
  it("reads map links, geo URIs and plain pairs", () => {
    expect(parseCoordinates("https://www.google.com/maps/place/Obelisco/@-34.6037,-58.3816,17z/data=!3d-34.60372!4d-58.38159")).toEqual({ lat: -34.60372, lng: -58.38159 });
    expect(parseCoordinates("https://maps.google.com/?q=-34.6,-58.4")).toEqual({ lat: -34.6, lng: -58.4 });
    expect(parseCoordinates("https://www.google.com/maps/@52.37,4.89,14z")).toEqual({ lat: 52.37, lng: 4.89 });
    expect(parseCoordinates("https://www.openstreetmap.org/#map=15/52.3702/4.8952")).toEqual({ lat: 52.3702, lng: 4.8952 });
    expect(parseCoordinates("https://www.openstreetmap.org/?mlat=52.37&mlon=4.89")).toEqual({ lat: 52.37, lng: 4.89 });
    expect(parseCoordinates("geo:40.4168,-3.7038")).toEqual({ lat: 40.4168, lng: -3.7038 });
    expect(parseCoordinates(" -34.6037, -58.3816 ")).toEqual({ lat: -34.6037, lng: -58.3816 });
    expect(parseCoordinates("Av. Corrientes 1234, CABA")).toBeNull();
    expect(parseCoordinates("123, 456")).toBeNull();
    expect(parseCoordinates("https://maps.app.goo.gl/abc")).toBeNull();
  });

  it("measures distances", () => {
    // Buenos Aires → Montevideo ≈ 205 km.
    expect(Math.round(distanceKm({ lat: -34.6037, lng: -58.3816 }, { lat: -34.9011, lng: -56.1645 }))).toBe(205);
  });

  it("geocodes through Nominatim politely, one request at a time", async () => {
    const calls: Array<{ url: string; ua: string; at: number }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ua: (init?.headers as Record<string, string>)["User-Agent"], at: Date.now() });
      return new Response(JSON.stringify(url.includes("nowhere") ? [] : [{ lat: "52.37", lon: "4.89", display_name: "Amsterdam" }]));
    }) as unknown as typeof fetch;
    const geo = nominatimGeocoder({ baseUrl: "http://geo.test/", fetchImpl: fake, minIntervalMs: 30 });
    const [a, b] = await Promise.all([geo("Dam 1, Amsterdam"), geo("nowhere")]);
    expect(a).toEqual({ lat: 52.37, lng: 4.89, label: "Amsterdam" });
    expect(b).toBeNull();
    expect(calls[0].url).toBe("http://geo.test/search?format=jsonv2&limit=1&q=Dam%201%2C%20Amsterdam");
    expect(calls[0].ua).toContain("Kernl");
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(25);
  });
});

function db() {
  const d = new Database(":memory:");
  runMigrations(d, "places", placesMigrations);
  d.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT, status TEXT, start_at TEXT, location TEXT NOT NULL DEFAULT '', location_url TEXT NOT NULL DEFAULT '');
    CREATE TABLE travel_accommodations (id TEXT PRIMARY KEY, name TEXT, address TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', check_in TEXT);
  `);
  d.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run("e1", "Asado", "open", "2026-12-01", "Parque Centenario", "https://maps.google.com/?q=-34.6064,-58.4357");
  d.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run("e2", "Fútbol", "open", "2026-12-02", "Av. Corrientes 1234", "");
  d.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run("e3", "Cancelled", "cancelled", "2026-12-03", "x", "geo:1,1");
  d.prepare("INSERT INTO travel_accommodations VALUES (?, ?, ?, ?, ?)").run("h1", "Hotel Montevideo", "Rambla 1", "", "2026-12-10");
  return d;
}

describe("places", () => {
  it("syncs sources, follows changes, keeps hand-set places and answers near", async () => {
    const d = db();
    const geocoded: string[] = [];
    const svc = new PlacesService(d, () => null, async (text) => {
      geocoded.push(text);
      return text === "Rambla 1" ? { lat: -34.9011, lng: -56.1645 } : null;
    });

    const first = await svc.sync();
    expect(first).toMatchObject({ scanned: 3, added: 3, fromLinks: 1, geocoded: 1, geocodeFailed: 1, pending: 1 });
    // A failed lookup is not retried on the next sync.
    geocoded.length = 0;
    expect((await svc.sync()).geocodeFailed).toBe(0);
    expect(geocoded).toEqual([]);

    const near = svc.near({ lat: -34.6037, lng: -58.3816 }, { radiusKm: 10 });
    expect(near.map((p) => [p.ref_id, p.km])).toEqual([["e1", 4.96]]);
    expect(svc.near({ lat: -34.6037, lng: -58.3816 }, { radiusKm: 300 }).map((p) => p.ref_id)).toEqual(["e1", "h1"]);
    expect(svc.near({ lat: -34.6037, lng: -58.3816 }, { radiusKm: 300, kinds: ["accommodation"] }).map((p) => p.ref_id)).toEqual(["h1"]);

    // By hand: e2 gets coordinates and a sync does not undo them.
    await svc.set({ kind: "event", ref_id: "e2", lat: -34.6036, lng: -58.3835 });
    d.prepare("UPDATE events SET title = 'Fútbol 5' WHERE id = 'e2'").run();
    await svc.sync();
    expect(svc.list({ kind: "event" }).find((p) => p.ref_id === "e2")).toMatchObject({ source: "manual", name: "Fútbol 5", lat: -34.6036 });

    // The link went away and the address changed: the old coordinates no longer apply.
    d.prepare("UPDATE events SET location = 'Otro lugar', location_url = '' WHERE id = 'e1'").run();
    await svc.sync();
    expect(svc.list({ missing: true }).map((p) => p.ref_id)).toEqual(["e1"]);

    // Deleted items leave.
    d.prepare("DELETE FROM travel_accommodations").run();
    expect((await svc.sync()).removed).toBe(1);

    // "Here" by a known place's name.
    await svc.set({ kind: "manual", name: "Casa", lat: -34.58, lng: -58.42 });
    expect(await svc.resolve("casa")).toEqual({ lat: -34.58, lng: -58.42, label: "Casa" });
    expect(await svc.resolve("geo:10,10")).toMatchObject({ lat: 10, lng: 10 });
  });

  it.skipIf(!relateClientInstalled())("projects places as points the graph can measure", async () => {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    const svc = new PlacesService(db(), () => g, null);
    await svc.ensureSchema();
    await svc.sync();
    const r = await g.run(
      `MATCH (p:Place) WHERE p.loc IS NOT NULL
       RETURN p.name AS name, round(point.distance(p.loc, point({latitude: -34.6037, longitude: -58.3816})) / 1000) AS km`,
    );
    expect(r.records.map((x) => [x.get("name"), Number(x.get("km"))])).toEqual([["Asado", 5]]);
    expect((await svc.graphBackfill()).nodes).toBe(3);
  });
});

import { describe, it, expect } from "bun:test";
import { placesSearch, resetPlacesRateLimit } from "../src/modules/projects/places.js";

const page = (n: number, token?: string) => ({
  places: Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, displayName: { text: `Clínica ${i}` }, formattedAddress: "Córdoba", nationalPhoneNumber: "0351 444",
    websiteUri: "https://c.ar", rating: 4.5, userRatingCount: 10, googleMapsUri: "https://maps", types: ["doctor"],
  })),
  ...(token ? { nextPageToken: token } : {}),
});

describe("places search", () => {
  it("asks for the key when missing", async () => {
    resetPlacesRateLimit();
    expect(await placesSearch({ query: "clínicas" }, { apiKey: () => "" })).toEqual({ ok: false, error: expect.stringMatching(/Ajustes → Integraciones/) });
  });

  it("queries the Places API with the field mask and paginates to the limit", async () => {
    resetPlacesRateLimit();
    const calls: any[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      calls.push({ url, body: JSON.parse(String(init.body)), mask: h["X-Goog-FieldMask"], key: h["X-Goog-Api-Key"] });
      return new Response(JSON.stringify(calls.length === 1 ? page(20, "t2") : page(20)));
    }) as unknown as typeof fetch;
    const r = await placesSearch({ query: "clínicas", location: "Córdoba, Argentina", limit: 30 }, { apiKey: () => "K", fetchFn });
    if (!r.ok) throw new Error(r.error);
    expect(r.places.length).toBe(30);
    expect(r.places[0]).toEqual({ place_id: "p0", name: "Clínica 0", address: "Córdoba", phone: "0351 444", website: "https://c.ar", rating: 4.5, reviews: 10, maps_url: "https://maps", types: ["doctor"] });
    expect(calls[0].url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(calls[0].body.textQuery).toBe("clínicas en Córdoba, Argentina");
    expect(calls[1].body.pageToken).toBe("t2");
    expect(calls[0].mask).toContain("places.websiteUri");
    expect(calls[0].mask).toContain("nextPageToken");
    expect(calls[0].key).toBe("K");
  });

  it("reports an API error instead of throwing", async () => {
    resetPlacesRateLimit();
    const fetchFn = (async () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 })) as unknown as typeof fetch;
    expect(await placesSearch({ query: "x" }, { apiKey: () => "K", fetchFn })).toEqual({ ok: false, error: expect.stringMatching(/400.*API key not valid/) });
  });

  it("rate-limits a looping agent", async () => {
    resetPlacesRateLimit();
    const fetchFn = (async () => new Response(JSON.stringify(page(1)))) as unknown as typeof fetch;
    let now = 1_000_000;
    for (let i = 0; i < 10; i++) expect((await placesSearch({ query: "x" }, { apiKey: () => "K", fetchFn, now: () => now })).ok).toBe(true);
    expect(await placesSearch({ query: "x" }, { apiKey: () => "K", fetchFn, now: () => now })).toEqual({ ok: false, error: expect.stringMatching(/Demasiadas búsquedas/) });
    now += 61_000;
    expect((await placesSearch({ query: "x" }, { apiKey: () => "K", fetchFn, now: () => now })).ok).toBe(true);
  });

  it("a network failure is a message, not a throw", async () => {
    resetPlacesRateLimit();
    const fetchFn = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;
    expect(await placesSearch({ query: "x" }, { apiKey: () => "K", fetchFn })).toEqual({ ok: false, error: expect.stringMatching(/No pude contactar a Google Places/) });
  });
});

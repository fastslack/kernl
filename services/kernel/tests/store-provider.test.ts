import { test, expect } from "bun:test";
import { StoreProvider } from "../src/modules/marketplace/catalog/store-provider.js";
import { isNewer } from "../src/modules/marketplace/catalog/registry.js";

/** A store catalog response shaped like the issuer's /store/catalog. */
function fakeStore(items: unknown[], opts?: { onCall?: () => void; fail?: boolean }) {
  return (async () => {
    opts?.onCall?.();
    if (opts?.fail) return new Response("nope", { status: 503 });
    return new Response(JSON.stringify({ items, all_access: { monthly: { price_id: "price_m", price_cents: 1200, currency: "USD", interval: "month" }, yearly: null } }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const TV = {
  slug: "tv-station",
  name: "Kernl TV",
  feature: "pro:tv-station",
  version: "1.13.0",
  type: "extension",
  description: "Seven channels of public-domain television.",
  icon: "📺",
  category: "leisure",
  ext_type: "module",
  price_id: "price_tv",
  price_cents: 900,
  currency: "USD",
  kind: "one_time",
};

test("store items the license does not cover come back as for_sale, with the price", async () => {
  const p = new StoreProvider({
    storeUrl: "https://store.example",
    licenseHas: () => false,
    fetchImpl: fakeStore([TV]),
    cacheTtlMs: 0,
  });

  const items = await p.list();
  expect(items).toHaveLength(1);
  const tv = items[0]!;
  expect(tv.status).toBe("for_sale");
  expect(tv.price_cents).toBe(900);
  expect(tv.currency).toBe("USD");
  expect(tv.price_id).toBe("price_tv");
  expect(tv.feature).toBe("pro:tv-station");
  // The synthesized manifest has to be renderable like any other card.
  expect(tv.manifest.name).toBe("Kernl TV");
  expect(tv.manifest.icon).toBe("📺");
  expect(tv.manifest.type).toBe("module");
  expect(tv.id).toBe("com.lifekernl.tv-station");
});

test("the same item flips to owned once the license carries its feature", async () => {
  const p = new StoreProvider({
    storeUrl: "https://store.example",
    licenseHas: (f) => f === "pro:tv-station",
    fetchImpl: fakeStore([TV]),
    cacheTtlMs: 0,
  });

  const items = await p.list();
  expect(items[0]!.status).toBe("owned");
  // Price still travels with it — the UI shows "✓ Owned", not "free".
  expect(items[0]!.price_cents).toBe(900);
});

test("search matches name and description, not just the slug", async () => {
  const p = new StoreProvider({
    storeUrl: "https://store.example",
    licenseHas: () => false,
    fetchImpl: fakeStore([TV]),
    cacheTtlMs: 0,
  });

  // This is the bug the redesign fixes: searching "tv" used to hit only the
  // installed rows and come back empty.
  expect(await p.list({ query: "tv" })).toHaveLength(1);
  expect(await p.list({ query: "television" })).toHaveLength(1);
  expect(await p.list({ query: "spreadsheet" })).toHaveLength(0);
});

test("the catalog is cached, so a keystroke-per-browse UI doesn't hammer the store", async () => {
  let calls = 0;
  const p = new StoreProvider({
    storeUrl: "https://store.example",
    licenseHas: () => false,
    fetchImpl: fakeStore([TV], { onCall: () => { calls++; } }),
    cacheTtlMs: 60_000,
  });

  await p.list();
  await p.list();
  await p.list({ query: "tv" });
  expect(calls).toBe(1);

  await p.refresh();
  expect(calls).toBe(2);
});

test("an unreachable store degrades to an empty shelf, not a thrown browse", async () => {
  const p = new StoreProvider({
    storeUrl: "https://store.example",
    licenseHas: () => false,
    fetchImpl: fakeStore([], { fail: true }),
    cacheTtlMs: 60_000,
  });

  expect(await p.list()).toEqual([]);
  expect(p.getLastError()).toContain("503");
});

test("a store that goes down keeps serving the last good catalog", async () => {
  let fail = false;
  const impl = (async () => {
    if (fail) return new Response("down", { status: 500 });
    return new Response(JSON.stringify({ items: [TV] }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const p = new StoreProvider({
    storeUrl: "https://store.example",
    licenseHas: () => false,
    fetchImpl: impl,
    cacheTtlMs: 0,
  });

  expect(await p.list()).toHaveLength(1);
  fail = true;
  // Paid items must not vanish from a page the user is looking at.
  expect(await p.list()).toHaveLength(1);
});

test("all_access rides along for the unlock-everything upsell", async () => {
  const p = new StoreProvider({
    storeUrl: "https://store.example",
    licenseHas: () => false,
    fetchImpl: fakeStore([TV]),
    cacheTtlMs: 0,
  });
  const aa = await p.allAccess();
  expect(aa?.monthly?.price_cents).toBe(1200);
});

test("isNewer only reports real upgrades", () => {
  expect(isNewer("1.14.0", "1.13.0")).toBe(true);
  expect(isNewer("1.13.1", "1.13.0")).toBe(true);
  expect(isNewer("2.0.0", "1.99.99")).toBe(true);
  expect(isNewer("1.13.0", "1.13.0")).toBe(false);
  expect(isNewer("1.12.0", "1.13.0")).toBe(false);
  // Unparseable versions must never fabricate an update prompt.
  expect(isNewer("latest", "1.0.0")).toBe(false);
  expect(isNewer("1.0.0", "nightly")).toBe(false);
  // Prerelease suffixes are ignored rather than mis-ranked.
  expect(isNewer("1.14.0-beta.1", "1.13.0")).toBe(true);
});

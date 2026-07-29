import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { fetchStoreCatalog, downloadStoreBundle } from "../src/modules/store/client.js";

test("fetchStoreCatalog parses the catalog items", async () => {
  const fake = (async () =>
    new Response(
      JSON.stringify({ items: [{ slug: "trading", name: "Trading suite", feature: "pro:trading", version: "0.1.0" }] }),
      { headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  const items = await fetchStoreCatalog("https://store.example/", fake);
  expect(items).toHaveLength(1);
  expect(items[0]!.slug).toBe("trading");
  expect(items[0]!.feature).toBe("pro:trading");
});

test("downloadStoreBundle writes the bundle to disk and sends the license as Bearer auth", async () => {
  let sawAuth = "";
  let sawUrl = "";
  const fake = (async (url: string, init?: RequestInit) => {
    sawUrl = url;
    sawAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  }) as unknown as typeof fetch;

  const out = await downloadStoreBundle({ storeUrl: "https://store.example", slug: "trading", licenseJwt: "JWT123", fetchImpl: fake });
  expect(out.bytes).toBe(4);
  expect(sawAuth).toBe("Bearer JWT123");
  expect(sawUrl).toContain("/store/download?slug=trading");
  const buf = await readFile(out.path);
  expect(buf.length).toBe(4);
});

test("downloadStoreBundle surfaces the store's error message (403 not entitled)", async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ error: "your license does not include Trading suite (pro:trading)" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  await expect(
    downloadStoreBundle({ storeUrl: "https://store.example", slug: "trading", licenseJwt: "JWT", fetchImpl: fake }),
  ).rejects.toThrow(/does not include/);
});

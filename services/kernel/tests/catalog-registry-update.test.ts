import { describe, it, expect } from "bun:test";
import { CatalogRegistry } from "../src/modules/marketplace/catalog/registry.js";
import type { CatalogItem, CatalogProvider } from "../src/modules/marketplace/catalog/types.js";

// The Extensions page's "Update to vX" button posts the catalog install of an item that is already installed. That
// is an update: before, the registry only re-enabled the installed row, so the card stayed on the old version and
// kept offering the same update.

function setup(installedVersion: string, catalogVersion: string) {
  const row = { id: "com.kernl.devops", slug: "devops", version: installedVersion, status: "active" } as any;
  const enabled: string[] = [];
  const extensionService = {
    list: () => [row],
    get: (id: string) => (id === row.id ? row : null),
    getBySlug: (slug: string) => (slug === row.slug ? row : null),
    enable: async (id: string) => { enabled.push(id); },
  } as any;
  const item = {
    id: "com.kernl.devops", slug: "devops", status: "owned", price_cents: 5900, currency: "usd",
    origin: { provider: "store", source: { type: "url", url: "https://store.test" } } as any,
    manifest: { id: "com.kernl.devops", slug: "devops", name: "DevOps Office", version: catalogVersion, type: "module" } as any,
  } as unknown as CatalogItem;
  const provider: CatalogProvider = { name: "store", label: "Kernl store", list: async () => [item], get: async (id) => (id === item.id || id === item.slug ? item : null) };
  const registry = new CatalogRegistry({ extensionService });
  registry.registerProvider(provider);
  const storeInstalls: string[] = [];
  registry.setStoreInstaller(async (slug) => { storeInstalls.push(slug); return { ...row, version: catalogVersion }; });
  return { registry, storeInstalls, enabled };
}

describe("catalog install of an installed item", () => {
  it("with a newer version in the store, updates it through the store installer", async () => {
    const s = setup("2.4.13", "2.4.14");
    const out = await s.registry.install("com.kernl.devops");
    expect(s.storeInstalls).toEqual(["devops"]);
    expect(out.version).toBe("2.4.14");
  });

  it("at the same version, only makes sure it is active, as before", async () => {
    const s = setup("2.4.14", "2.4.14");
    const out = await s.registry.install("devops");
    expect(s.storeInstalls).toEqual([]);
    expect(out.version).toBe("2.4.14");
  });
});

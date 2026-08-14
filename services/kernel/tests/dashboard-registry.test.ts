import { describe, it, expect } from "bun:test";
import { DashboardRegistry } from "../src/core/dashboard-registry.js";
import type { KernelModule, ExtensibleModule, DashboardDescriptor, ModuleContext } from "../src/core/types.js";
import type { ExtensionServiceLike } from "../src/core/dashboard-registry.js";

// ── Helpers ────────────────────────────────────────────

function makeModule(name: string): KernelModule {
  return {
    name,
    async initialize() {},
    getTools() { return []; },
    async shutdown() {},
  };
}

function makeExtensibleModule(name: string, descriptor: DashboardDescriptor | null): ExtensibleModule {
  return {
    ...makeModule(name),
    getDashboardDescriptor() { return descriptor; },
  };
}

// ── Tests ──────────────────────────────────────────────

describe("DashboardRegistry", () => {
  it("ignores non-extensible modules", () => {
    const reg = new DashboardRegistry();
    reg.registerModule(makeModule("tasks"));
    expect(reg.getRegisteredModules()).toEqual([]);
    expect(reg.getChannelNames()).toEqual([]);
  });

  it("ignores extensible modules returning null descriptor", () => {
    const reg = new DashboardRegistry();
    reg.registerModule(makeExtensibleModule("tasks", null));
    expect(reg.getRegisteredModules()).toEqual([]);
  });

  it("registers channels from descriptor", () => {
    const reg = new DashboardRegistry();
    reg.registerModule(makeExtensibleModule("finance", {
      channels: [
        { name: "finance", query: () => ({ totalBalanceCents: 1000 }) },
      ],
    }));

    expect(reg.getRegisteredModules()).toEqual(["finance"]);
    expect(reg.getChannelNames()).toEqual(["finance"]);
    expect(reg.hasChannel("finance")).toBe(true);
    expect(reg.hasChannel("nonexistent")).toBe(false);
  });

  it("queryChannel executes the registered query function", async () => {
    const reg = new DashboardRegistry();
    const queryFn = () => ({ accounts: [], totalBalanceCents: 5000 });
    reg.registerModule(makeExtensibleModule("finance", {
      channels: [{ name: "finance", query: queryFn }],
    }));

    const result = await reg.queryChannel("finance", {} as any, {} as any);
    expect(result).toEqual({ accounts: [], totalBalanceCents: 5000 });
  });

  it("queryChannel returns undefined for unregistered channels", async () => {
    const reg = new DashboardRegistry();
    const result = await reg.queryChannel("nonexistent", {} as any, {} as any);
    expect(result).toBeUndefined();
  });

  it("collects channel mappings from multiple modules", () => {
    const reg = new DashboardRegistry();
    reg.registerModule(makeExtensibleModule("finance", {
      channelMappings: [{ moduleKey: "finance", channels: ["finance"] }],
    }));
    reg.registerModule(makeExtensibleModule("notes", {
      channelMappings: [{ moduleKey: "notes", channels: ["notes"] }],
    }));

    const mappings = reg.getChannelMappings();
    expect(mappings).toHaveLength(2);
    expect(mappings[0].moduleKey).toBe("finance");
    expect(mappings[1].moduleKey).toBe("notes");
  });

  it("builds manifest with all registered data", () => {
    const reg = new DashboardRegistry();
    reg.registerModule(makeExtensibleModule("finance", {
      channels: [{ name: "finance", query: () => null }],
      channelMappings: [{ moduleKey: "finance", channels: ["finance"] }],
      stores: ["finance"],
      fetchEndpoints: [{ url: "/api/dashboard/finance", store: "finance" }],
    }));

    const manifest = reg.getManifest();
    expect(manifest.modules).toEqual(["finance"]);
    expect(manifest.stores).toEqual(["finance"]);
    expect(manifest.fetchEndpoints).toEqual([{ url: "/api/dashboard/finance", store: "finance" }]);
    expect(manifest.wsChannelMap).toEqual({ finance: ["finance"] });
  });

  it("collects nav items", () => {
    const reg = new DashboardRegistry();
    reg.registerModule(makeExtensibleModule("finance", {
      nav: [{ id: "finance", label: "Finance", icon: "💰", group: "finance" }],
    }));

    const manifest = reg.getManifest();
    expect(manifest.navItems).toHaveLength(1);
    expect(manifest.navItems[0].id).toBe("finance");
  });

  it("overwrites duplicate channel names with warning", () => {
    const reg = new DashboardRegistry();
    reg.registerModule(makeExtensibleModule("mod1", {
      channels: [{ name: "shared", query: () => ({ from: "mod1" }) }],
    }));
    reg.registerModule(makeExtensibleModule("mod2", {
      channels: [{ name: "shared", query: () => ({ from: "mod2" }) }],
    }));

    // Last one wins
    expect(reg.getChannelNames()).toEqual(["shared"]);
  });
});

/*
 * A view id is the URL segment, and the dashboard maps each one to exactly one
 * group (`viewToGroup`). Letting the same id land in two groups therefore can
 * never render correctly: the tab appears on both dials, but only one of them
 * can own the view, so on the other it never highlights.
 *
 * This is not hypothetical — the torrents extension declared `torrents` under
 * `people` from its module descriptor and under `leisure` from its manifest,
 * and both survived a dedup keyed on (id, group).
 */
describe("DashboardRegistry — one view id, one group", () => {
  function extStub(manifests: Array<Record<string, unknown>>): ExtensionServiceLike {
    return {
      list: () =>
        manifests.map((m, i) => ({
          id: `ext${i}`,
          slug: String(m.slug ?? `ext${i}`),
          status: "active",
          manifest_json: JSON.stringify(m),
        })),
    };
  }

  it("keeps the module's nav item when an extension manifest claims the same id for another group", () => {
    const reg = new DashboardRegistry();
    reg.registerModule(
      makeExtensibleModule("torrents", {
        nav: [{ id: "torrents", label: "Torrents", icon: "🧲", group: "people", order: 6 }],
      }),
    );

    const manifest = reg.getManifest(
      extStub([
        {
          slug: "torrents",
          frontend: {
            navItems: [{ id: "torrents", label: "Torrents", icon: "🧲", group: "leisure", order: 40 }],
          },
        },
      ]),
    );

    const torrents = manifest.navItems.filter((i) => i.id === "torrents");
    expect(torrents).toHaveLength(1);
    expect(torrents[0].group).toBe("people"); // first registration wins
  });

  it("does not let two extensions claim one view id for different groups", () => {
    const reg = new DashboardRegistry();
    const manifest = reg.getManifest(
      extStub([
        { slug: "a", frontend: { navItems: [{ id: "shared", label: "A", icon: "①", group: "leisure" }] } },
        { slug: "b", frontend: { navItems: [{ id: "shared", label: "B", icon: "②", group: "people" }] } },
      ]),
    );

    const shared = manifest.navItems.filter((i) => i.id === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0].group).toBe("leisure");
  });

  it("does not let two in-process modules claim one view id", () => {
    const reg = new DashboardRegistry();
    reg.registerModule(
      makeExtensibleModule("a", { nav: [{ id: "shared", label: "A", icon: "①", group: "leisure" }] }),
    );
    reg.registerModule(
      makeExtensibleModule("b", { nav: [{ id: "shared", label: "B", icon: "②", group: "people" }] }),
    );

    const shared = reg.getManifest().navItems.filter((i) => i.id === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0].group).toBe("leisure");
  });

  it("still allows distinct ids inside the same group", () => {
    const reg = new DashboardRegistry();
    const manifest = reg.getManifest(
      extStub([
        {
          slug: "a",
          frontend: {
            navItems: [
              { id: "one", label: "One", icon: "①", group: "leisure" },
              { id: "two", label: "Two", icon: "②", group: "leisure" },
            ],
          },
        },
      ]),
    );
    expect(manifest.navItems.map((i) => i.id).sort()).toEqual(["one", "two"]);
  });
});

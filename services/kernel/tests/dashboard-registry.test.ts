import { describe, it, expect } from "bun:test";
import { DashboardRegistry } from "../src/core/dashboard-registry.js";
import type { KernelModule, ExtensibleModule, DashboardDescriptor, ModuleContext } from "../src/core/types.js";

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

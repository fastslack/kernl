import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ModuleRegistry } from "../src/core/module-registry.js";
import type { KernelModule, ModuleContext } from "../src/core/types.js";
import { textResult } from "../src/core/helpers.js";

function createMockModule(name: string, toolCount: number): KernelModule {
  const tools = Array.from({ length: toolCount }, (_, i) => ({
    name: `${name}_tool_${i}`,
    description: `Tool ${i} from ${name}`,
    inputSchema: z.object({}) as z.ZodType<unknown>,
    handler: async () => textResult("ok"),
  }));

  return {
    name,
    async initialize() {},
    getTools: () => tools,
    async shutdown() {},
  };
}

describe("ModuleRegistry", () => {
  it("registers modules and aggregates tools after initialization", async () => {
    const registry = new ModuleRegistry();
    registry.register(createMockModule("alpha", 3));
    registry.register(createMockModule("beta", 2));

    // Before initialization, getAllTools returns empty (modules not initialized)
    expect(registry.getAllTools()).toHaveLength(0);

    // After initialization, tools are available
    await registry.initializeAll({} as ModuleContext);
    const tools = registry.getAllTools();
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toContain("alpha_tool_0");
    expect(tools.map((t) => t.name)).toContain("beta_tool_1");
  });

  it("initializes all modules and returns result", async () => {
    const initOrder: string[] = [];
    const mod: KernelModule = {
      name: "test",
      async initialize() {
        initOrder.push("test");
      },
      getTools: () => [],
      async shutdown() {},
    };

    const registry = new ModuleRegistry();
    registry.register(mod);
    const result = await registry.initializeAll({} as ModuleContext);

    expect(initOrder).toEqual(["test"]);
    expect(result.succeeded).toEqual(["test"]);
    expect(result.failed).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles module initialization failures gracefully", async () => {
    const failMod: KernelModule = {
      name: "fail",
      async initialize() {
        throw new Error("init failed");
      },
      getTools: () => [],
      async shutdown() {},
    };
    const okMod: KernelModule = {
      name: "ok",
      async initialize() {},
      getTools: () => [],
      async shutdown() {},
    };

    const registry = new ModuleRegistry();
    registry.register(failMod);
    registry.register(okMod);
    const result = await registry.initializeAll({} as ModuleContext);

    // Both modules attempted, one failed, one succeeded
    expect(result.succeeded).toEqual(["ok"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe("fail");

    // Only initialized modules are tracked
    expect(registry.isModuleInitialized("ok")).toBe(true);
    expect(registry.isModuleInitialized("fail")).toBe(false);
  });

  it("shuts down initialized modules in reverse order", async () => {
    const shutdownOrder: string[] = [];

    const modA: KernelModule = {
      name: "a",
      async initialize() {},
      getTools: () => [],
      async shutdown() {
        shutdownOrder.push("a");
      },
    };
    const modB: KernelModule = {
      name: "b",
      async initialize() {},
      getTools: () => [],
      async shutdown() {
        shutdownOrder.push("b");
      },
    };

    const registry = new ModuleRegistry();
    registry.register(modA);
    registry.register(modB);
    await registry.initializeAll({} as ModuleContext);
    await registry.shutdownAll();

    // Shutdown in reverse order (LIFO)
    expect(shutdownOrder).toEqual(["b", "a"]);
  });

  it("shuts down all modules even if one fails", async () => {
    const shutdownOrder: string[] = [];

    const failMod: KernelModule = {
      name: "fail",
      async initialize() {},
      getTools: () => [],
      async shutdown() {
        shutdownOrder.push("fail");
        throw new Error("boom");
      },
    };
    const okMod: KernelModule = {
      name: "ok",
      async initialize() {},
      getTools: () => [],
      async shutdown() {
        shutdownOrder.push("ok");
      },
    };

    const registry = new ModuleRegistry();
    registry.register(failMod);
    registry.register(okMod);
    await registry.initializeAll({} as ModuleContext);
    await registry.shutdownAll();

    // Shutdown in reverse order: ok first, then fail
    expect(shutdownOrder).toEqual(["ok", "fail"]);
  });

  it("only shuts down initialized modules", async () => {
    const shutdownOrder: string[] = [];

    const failInit: KernelModule = {
      name: "failInit",
      async initialize() {
        throw new Error("init failed");
      },
      getTools: () => [],
      async shutdown() {
        shutdownOrder.push("failInit");
      },
    };
    const okMod: KernelModule = {
      name: "ok",
      async initialize() {},
      getTools: () => [],
      async shutdown() {
        shutdownOrder.push("ok");
      },
    };

    const registry = new ModuleRegistry();
    registry.register(failInit);
    registry.register(okMod);
    await registry.initializeAll({} as ModuleContext);
    await registry.shutdownAll();

    // Only "ok" was initialized, so only "ok" is shut down
    expect(shutdownOrder).toEqual(["ok"]);
  });
});

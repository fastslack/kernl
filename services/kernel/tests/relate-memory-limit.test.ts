import { describe, it, expect, afterEach } from "bun:test";
import { RelateGraphDriver, relateClientInstalled, operatorGraphCap, setProcessEnv } from "../src/core/db-drivers/builtins/relate-graph-driver.js";

/**
 * The size cap reaches the engine. Relate reads RELATE_LOGICAL_GRAPH_SIZE_LIMIT
 * from the real environment when a store opens, and under Bun an assignment
 * to process.env does not get there: the driver puts the cap it applies into
 * the environment through libc. A cap someone chose applies; none otherwise.
 */
describe.skipIf(!relateClientInstalled())("Relate's memory limit", () => {
  const drivers: RelateGraphDriver[] = [];
  afterEach(async () => {
    for (const d of drivers.splice(0)) await d.stop();
    // Leave the process as the other suites expect it: no cap.
    await setProcessEnv("RELATE_LOGICAL_GRAPH_SIZE_LIMIT", null);
  });

  async function start(memoryLimit?: string) {
    const d = new RelateGraphDriver();
    d.configure({ path: ":memory:", ...(memoryLimit ? { memoryLimit } : {}) });
    await d.start();
    drivers.push(d);
    return d;
  }

  /** Writes small nodes until the engine refuses; how many fit. */
  async function fill(d: RelateGraphDriver, max: number): Promise<{ n: number; error: string }> {
    let n = 0;
    try {
      while (n < max) {
        await d.run("UNWIND range(1, 5000) AS i CREATE (:Fill {i: i, name: 'Lucía Ferreyra'})");
        n += 5000;
      }
    } catch (err) {
      return { n, error: err instanceof Error ? err.message : String(err) };
    }
    return { n, error: "" };
  }

  it("a memoryLimit chosen in /extensions is enforced", async () => {
    delete process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT;
    const d = await start("16mib");
    const r = await fill(d, 200_000);
    expect(r.error).toContain("capacity exceeded");
    expect(r.n).toBeLessThan(60_000);
  }, 60_000);

  it("without one, the graph is not capped (as before): an install never stops writing because of a default", async () => {
    delete process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT;
    const d = await start();
    expect(process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT).toBeUndefined();
    // Past what 16 MiB holds (about 33k of these nodes).
    expect((await fill(d, 50_000)).error).toBe("");
  }, 60_000);

  it("none (or empty) means no cap: the variable is removed, since the engine refuses \"none\"", async () => {
    process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT = "none";
    const d = await start("none");
    expect(d.isReady()).toBe(true);
    expect((await fill(d, 50_000)).error).toBe("");
  }, 60_000);

  it("the operator's environment wins over memoryLimit, and is told apart from what the driver left", async () => {
    process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT = "16mib";
    expect(operatorGraphCap()).toBe("16mib");
    const d = await start("8gib");
    expect((await fill(d, 200_000)).error).toContain("capacity exceeded");
    await d.stop();
    drivers.splice(0);
    delete process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT;
    // The driver's own value is not mistaken for the operator's on the next start.
    const d2 = await start("8gib");
    expect(process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT as string | undefined).toBe("8gib");
    expect(operatorGraphCap()).toBe("");
    expect((await fill(d2, 50_000)).error).toBe("");
  }, 60_000);
});

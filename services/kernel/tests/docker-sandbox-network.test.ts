import { describe, it, expect } from "bun:test";
import { resolveNetwork } from "../src/core/sandbox/drivers/docker-driver.js";

describe("docker driver network resolution", () => {
  it("passes the plain modes and named networks through", () => {
    expect(resolveNetwork(undefined)).toBe("bridge");
    expect(resolveNetwork("bridge")).toBe("bridge");
    expect(resolveNetwork("none")).toBe("none");
    expect(resolveNetwork("kernl_default")).toBe("kernl_default");
  });

  it("refuses an egress allowlist instead of opening the network", () => {
    expect(() => resolveNetwork({ mode: "egress-policy", allowHosts: ["api.github.com"] })).toThrow(
      /cannot enforce an egress allowlist/,
    );
  });

  it("refuses a network name that could smuggle docker flags", () => {
    expect(() => resolveNetwork("host --privileged")).toThrow(/invalid docker network name/);
  });
});

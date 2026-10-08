import { describe, it, expect } from "bun:test";
import { kernlClaudeSessionFiles, resolveNetwork } from "../src/core/sandbox/drivers/docker-driver.js";

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

describe("the Claude session a sandboxed agent gets", () => {
  it("is Kernl's own sign-in, not the operator's host login", () => {
    // Sandboxes used to mount $HOST_HOME/.claude: agents kept running on that
    // subscription while AI connections said Claude Code was disconnected.
    const saved = { xdg: process.env.XDG_CONFIG_HOME, host: process.env.HOST_HOME };
    process.env.XDG_CONFIG_HOME = "/app/data/xdg";
    process.env.HOST_HOME = "/home/operator";
    try {
      const s = kernlClaudeSessionFiles();
      expect(s.creds).toBe("/app/data/xdg/kernl/claude/.credentials.json");
      expect(s.json).toBe("/app/data/xdg/kernl/claude/.claude.json");
      expect(`${s.creds} ${s.json}`).not.toContain("/home/operator");
    } finally {
      if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.xdg;
      if (saved.host === undefined) delete process.env.HOST_HOME; else process.env.HOST_HOME = saved.host;
    }
  });
});

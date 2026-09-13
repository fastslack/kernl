import { describe, it, expect } from "bun:test";
import { sameLinkTarget } from "../src/modules/extensions/ensure-packages.js";
import { isPathAllowed } from "../src/modules/agents/audit-tools.js";
import { ptyCommand } from "../src/core/llm/claude-code-auth.js";
import { chooseKernelMcpTransport, resolveMcpBridgePath } from "../src/core/mcp-unix-socket.js";

describe("sameLinkTarget", () => {
  it("treats a junction read back with a trailing separator and other case as the same target", () => {
    expect(sameLinkTarget("c:\\program files\\kernl\\node_modules\\", "C:\\Program Files\\Kernl\\node_modules", true))
      .toBe(true);
  });

  it("stays exact on POSIX", () => {
    expect(sameLinkTarget("/opt/kernl/node_modules/", "/opt/kernl/node_modules", false)).toBe(false);
    expect(sameLinkTarget("/opt/kernl/node_modules", "/opt/kernl/node_modules", false)).toBe(true);
  });
});

describe("isPathAllowed (kernel_code_read)", () => {
  const root = "/srv/kernl";

  it("allows project sources", () => {
    expect(isPathAllowed("src/core/logger.ts", root)).toBe(true);
  });

  it("blocks the data dir, including the auth token and the database", () => {
    expect(isPathAllowed("data/kernel.db", root)).toBe(false);
    expect(isPathAllowed("data/.kernel-auth-token", root)).toBe(false);
    expect(isPathAllowed("data", root)).toBe(false);
  });

  it("blocks escapes and sibling directories sharing the prefix", () => {
    expect(isPathAllowed("../etc/passwd", root)).toBe(false);
    expect(isPathAllowed("/srv/kernl-old/src/x.ts", root)).toBe(false);
  });
});

describe("ptyCommand", () => {
  it("never offers a PTY helper on Windows, even with a script binary on PATH", () => {
    expect(ptyCommand(() => "C:\\Program Files\\Git\\usr\\bin\\script.exe", "win32")).toBeNull();
  });

  it("keeps the util-linux form on Linux", () => {
    expect(ptyCommand((c) => (c === "script" ? "/usr/bin/script" : null), "linux"))
      .toEqual(["/usr/bin/script", "-qec", "%CMD%", "/dev/null"]);
  });
});

describe("chooseKernelMcpTransport", () => {
  it("uses HTTP on Windows even when a bridge path is known", () => {
    expect(chooseKernelMcpTransport({ platform: "win32", bridgePath: "C:\\x\\mcp-stdio-bridge.js" })).toBe("http");
  });

  it("uses stdio on Linux when the bridge exists, HTTP when it does not", () => {
    expect(chooseKernelMcpTransport({ platform: "linux", bridgePath: "/app/dist/mcp-stdio-bridge.js" })).toBe("stdio");
    expect(chooseKernelMcpTransport({ platform: "linux", bridgePath: "" })).toBe("http");
  });

  it("lets an explicit choice win", () => {
    expect(chooseKernelMcpTransport({ platform: "win32", bridgePath: "", explicit: "STDIO" })).toBe("stdio");
    expect(chooseKernelMcpTransport({ platform: "linux", bridgePath: "/b.js", explicit: "http" })).toBe("http");
  });
});

describe("resolveMcpBridgePath", () => {
  it("returns the explicit path untouched", () => {
    expect(resolveMcpBridgePath("/custom/bridge.ts", () => false)).toBe("/custom/bridge.ts");
  });

  it("returns empty when no candidate exists — a native package ships none", () => {
    expect(resolveMcpBridgePath(undefined, () => false)).toBe("");
  });

  it("finds the built bridge beside the entry script", () => {
    const found = resolveMcpBridgePath(undefined, (p) => p.endsWith("mcp-stdio-bridge.js"));
    expect(found.endsWith("mcp-stdio-bridge.js")).toBe(true);
  });
});

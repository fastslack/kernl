import { describe, it, expect, afterEach } from "bun:test";
import { resolveKernelMcpUrl } from "../assets/extensions/agents/agent-advanced/_module/claude-code-executor.js";

const saved = { port: process.env.DASHBOARD_PORT, url: process.env.KERNEL_MCP_URL };
afterEach(() => {
  if (saved.port === undefined) delete process.env.DASHBOARD_PORT; else process.env.DASHBOARD_PORT = saved.port;
  if (saved.url === undefined) delete process.env.KERNEL_MCP_URL; else process.env.KERNEL_MCP_URL = saved.url;
});

describe("the MCP URL a claude_code agent calls back on", () => {
  it("is the port this kernel listens on, never a fixed one", () => {
    delete process.env.KERNEL_MCP_URL;
    delete process.env.DASHBOARD_PORT;
    expect(resolveKernelMcpUrl()).toBe("http://127.0.0.1:3086/mcp");
    process.env.DASHBOARD_PORT = "3187";
    expect(resolveKernelMcpUrl()).toBe("http://127.0.0.1:3187/mcp");
    process.env.DASHBOARD_PORT = "3087"; // Docker
    expect(resolveKernelMcpUrl()).toBe("http://127.0.0.1:3087/mcp");
    expect(resolveKernelMcpUrl(4000)).toBe("http://127.0.0.1:4000/mcp");
  });

  it("keeps an explicit local override and refuses a remote one", () => {
    process.env.DASHBOARD_PORT = "3086";
    process.env.KERNEL_MCP_URL = "http://localhost:5555/mcp";
    expect(resolveKernelMcpUrl()).toBe("http://localhost:5555/mcp");
    process.env.KERNEL_MCP_URL = "https://evil.example/mcp";
    expect(resolveKernelMcpUrl()).toBe("http://127.0.0.1:3086/mcp");
  });
});

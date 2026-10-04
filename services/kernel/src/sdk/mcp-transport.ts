/**
 * How the Claude Code SDK reaches the kernel's MCP server: the unix socket and
 * stdio bridge paths, and the stdio-vs-HTTP choice. Pure (node:fs and
 * node:path only), so extensions can import it without pulling the MCP server
 * itself into their bundle; src/core/mcp-unix-socket.ts re-exports it.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Default socket path.
 *
 *  Defaults to `/tmp/kernl-mcp.sock`: the SDK's bwrap sandbox
 *  (--unshare-net but with `allowAllUnixSockets: true`) reliably bind-mounts
 *  `/tmp` into the sandbox FS, so the socket is visible from inside agent
 *  subprocesses. `$XDG_RUNTIME_DIR`/`$HOME` paths often live under user-
 *  scoped dirs that bwrap doesn't expose by default, which would silently
 *  break the bridge.
 *
 *  Override priority: $KERNEL_MCP_SOCKET → /tmp default. */
export function resolveDefaultSocketPath(): string {
  const explicit = process.env.KERNEL_MCP_SOCKET;
  if (explicit) return explicit;
  return "/tmp/kernl-mcp.sock";
}

/**
 * The stdio bridge script the SDK spawns, or "" when this install has none.
 *
 * `<cwd>/bin/mcp-stdio-bridge.ts` only exists in a source checkout. The built
 * kernel carries it as `mcp-stdio-bridge.js` beside `mcp-server.js` (Docker's
 * /app/dist), and the native packages ship neither — they start in the user's
 * data dir with nothing but mcp-server.js. Pointing the SDK at a missing file
 * left the "kernel" MCP server pending forever with no error.
 */
export function resolveMcpBridgePath(
  explicit?: string,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  if (explicit) return explicit;
  const candidates = [
    path.join(process.cwd(), "bin", "mcp-stdio-bridge.ts"),
    path.join(path.dirname(process.argv[1] ?? ""), "mcp-stdio-bridge.js"),
  ];
  return candidates.find((c) => exists(c)) ?? "";
}

/**
 * stdio (bridge + unix socket) or HTTP for the kernel MCP server handed to the
 * Claude Code SDK. An explicit choice wins. Otherwise Windows always gets HTTP
 * — no unix socket listener runs there — and elsewhere stdio only when a
 * bridge script actually exists.
 */
export function chooseKernelMcpTransport(opts: {
  explicit?: string;
  bridgePath: string;
  platform?: NodeJS.Platform;
}): "stdio" | "http" {
  const explicit = (opts.explicit ?? "").toLowerCase();
  if (explicit === "http" || explicit === "stdio") return explicit;
  if ((opts.platform ?? process.platform) === "win32") return "http";
  return opts.bridgePath ? "stdio" : "http";
}

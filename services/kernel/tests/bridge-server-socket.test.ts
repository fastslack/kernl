/**
 * The kernel's bridge socket: a file left by a dead kernel is replaced, one a
 * live kernel still listens on is never unlinked (that cut the desktop app's
 * broker off when a dev kernel started on the same machine).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { createServer, connect, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeServer } from "../src/core/mtw/bridge-server.js";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function dir(): string {
  // Short: unix socket paths are limited to ~104 bytes.
  const d = mkdtempSync(path.join(tmpdir(), "kb-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const answers = (p: string) => new Promise<boolean>((resolve) => {
  const s = connect(p);
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});

describe("BridgeServer socket", () => {
  it("replaces a socket file nobody listens on", async () => {
    const sock = path.join(dir(), "k.sock");
    writeFileSync(sock, "");
    const bridge = new BridgeServer({ socketPath: sock, tools: [] });
    await bridge.start();
    cleanup.push(() => bridge.shutdown());
    expect(await answers(sock)).toBe(true);
  });

  it("leaves a live kernel's socket alone and refuses to start", async () => {
    const sock = path.join(dir(), "k.sock");
    const other: Server = createServer((c) => c.end());
    await new Promise<void>((r) => other.listen(sock, r));
    cleanup.push(() => other.close());

    const bridge = new BridgeServer({ socketPath: sock, tools: [] });
    await expect(bridge.start()).rejects.toThrow(/another running kernel/);
    expect(existsSync(sock)).toBe(true);
    expect(await answers(sock)).toBe(true);
  });
});

import { describe, it, expect, afterEach } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { socketIsServed } from "../src/core/mcp-unix-socket.js";

// A second kernel on the same machine (a demo, a test instance) must not take
// the MCP socket path away from the one already serving it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernl-sock-"));
const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe("socketIsServed", () => {
  it("is false when there is no file", async () => {
    expect(await socketIsServed(path.join(dir, "none.sock"))).toBe(false);
  });

  it("is true while another process listens on the path", async () => {
    const p = path.join(dir, "live.sock");
    const s = net.createServer(() => {});
    servers.push(s);
    await new Promise<void>((r) => s.listen(p, r));
    expect(await socketIsServed(p)).toBe(true);
  });

  it("is false for a stale file left behind by a crash", async () => {
    const p = path.join(dir, "stale.sock");
    fs.writeFileSync(p, "");
    expect(await socketIsServed(p)).toBe(false);
  });
});

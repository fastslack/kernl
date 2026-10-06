/**
 * Downloading a received file to the browser. In Bun an unhandled stream
 * error terminates the process, so a file that vanished between the lookup
 * and the read, a directory in its place, or a client hanging up mid-way must
 * all end the response — never the kernel.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { registerTransferOwnerRoutes } from "../src/core/social-net/file-lane/owner-routes.js";
import type { TransferOwner } from "../src/core/social-net/file-lane/owner.js";

let server: KernelHttpServer;
let base: string;
let port: number;
let dir: string;
const files = new Map<string, { path: string; name: string; size: number; mime: string }>();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "fl-dl-"));
  files.clear();
  // filePath() checked existence at lookup time; what happens after is the route's problem.
  const owner = { filePath: (id: string) => files.get(id) ?? null } as unknown as TransferOwner;
  server = new KernelHttpServer({
    config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
  });
  registerTransferOwnerRoutes(server, owner);
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await server.stop();
});

function add(id: string, name: string, bytes?: Uint8Array): string {
  const path = join(dir, name);
  if (bytes) writeFileSync(path, bytes);
  files.set(id, { path, name, size: bytes?.length ?? 4, mime: "application/octet-stream" });
  return path;
}

describe("file-lane download route", () => {
  it("serves the whole file and a range", async () => {
    add("t1", "a.bin", new TextEncoder().encode("hola mundo"));
    const whole = await fetch(`${base}/api/transfers/t1/files/0`);
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe("hola mundo");
    const part = await fetch(`${base}/api/transfers/t1/files/0`, { headers: { range: "bytes=5-9" } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("mundo");
  });

  it("answers 404 when the file vanished after the lookup, and keeps serving", async () => {
    const path = add("gone", "gone.bin", new Uint8Array(4));
    rmSync(path);
    expect((await fetch(`${base}/api/transfers/gone/files/0`)).status).toBe(404);
    expect((await fetch(`${base}/api/transfers/gone/files/0`, { headers: { range: "bytes=0-1" } })).status).toBe(404);
    add("ok", "ok.bin", new Uint8Array(3));
    expect((await fetch(`${base}/api/transfers/ok/files/0`)).status).toBe(200);
  });

  it("answers 404 when a directory took the file's place (EISDIR)", async () => {
    const path = add("dir", "folder");
    mkdirSync(path);
    expect((await fetch(`${base}/api/transfers/dir/files/0`)).status).toBe(404);
  });

  it("survives a client that hangs up mid-download", async () => {
    add("big", "big.bin", new Uint8Array(randomBytes(32 * 1024 * 1024)));
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/transfers/big/files/0" }, (res) => {
        res.once("data", () => { req.destroy(); resolve(); });
      });
      req.on("error", () => resolve());
      req.end();
    });
    await new Promise((r) => setTimeout(r, 50));
    add("after", "after.bin", new TextEncoder().encode("still here"));
    expect(await (await fetch(`${base}/api/transfers/after/files/0`)).text()).toBe("still here");
  });
});

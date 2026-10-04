/**
 * GET /api/attachments serves bytes whose type and name came from an email.
 *
 * Rules under test: no wildcard CORS (the server's allow-list applies, like
 * every other route), and nothing that can carry script is rendered inline
 * from the kernel's origin.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { registerCommsDashboardRoutes } from "../assets/extensions/people/comms/_module/dashboard-routes.js";

const dir = mkdtempSync(join(tmpdir(), "att-"));
const files: Record<string, { stored_path: string; mime_type: string; filename: string }> = {};
for (const [id, mime, name] of [
  ["png", "image/png", "photo.png"],
  ["html", "text/html", "invoice.html"],
  ["svg", "image/svg+xml", "logo.svg"],
  ["quote", "application/pdf", 'a"b.pdf'],
]) {
  const path = join(dir, id);
  writeFileSync(path, "x");
  files[id] = { stored_path: path, mime_type: mime, filename: name };
}

const server = new KernelHttpServer({
  config: {
    dashboard: { port: 0, bind: "127.0.0.1" },
    auth: { token: "" },
    cors: { allowedOrigins: ["https://good.example"] },
  } as unknown as KernelConfig,
});
registerCommsDashboardRoutes(
  server,
  {} as never,
  { getAttachment: (id: string) => files[id] } as never,
  { emit() {} } as never,
);
let base = "";

beforeAll(async () => {
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => { await server.stop(); });

const get = (id: string, origin?: string) =>
  fetch(`${base}/api/attachments?id=${id}`, { headers: origin ? { Origin: origin } : {} });

describe("GET /api/attachments", () => {
  it("sends no CORS header to an origin outside the allow-list", async () => {
    const r = await get("png", "https://evil.example");
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("echoes an allow-listed origin", async () => {
    const r = await get("png", "https://good.example");
    expect(r.headers.get("access-control-allow-origin")).toBe("https://good.example");
  });

  it("previews a safe type inline", async () => {
    const r = await get("png");
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("content-disposition")).toStartWith("inline;");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("downloads HTML and SVG instead of rendering them", async () => {
    for (const id of ["html", "svg"]) {
      const r = await get(id);
      expect(r.headers.get("content-type")).toBe("application/octet-stream");
      expect(r.headers.get("content-disposition")).toStartWith("attachment;");
    }
  });

  it("keeps a quote in the name from breaking the header", async () => {
    const r = await get("quote");
    expect(r.headers.get("content-disposition")).toBe('inline; filename="a_b.pdf"');
  });
});

/**
 * `server.route()` — the JSON route helper that replaces the per-handler
 * try/catch + params cast + parseBody scaffolding.
 *
 * Contract under test: the return value is the 200 body; HttpError maps to
 * its status and body; anything else thrown is a 500 carrying String(err);
 * an empty body is `{}` and a malformed one a 400. Also: a plain handler that
 * throws HttpError gets that status from the dispatcher.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { KernelHttpServer, HttpError } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";

const cfg = {
  dashboard: { port: 0, bind: "127.0.0.1" },
  auth: { token: "" },
  cors: { allowedOrigins: [] },
} as unknown as KernelConfig;

const server = new KernelHttpServer({ config: cfg });
let base = "";

server.route("GET", "/api/t/items/:id", ({ params, query }) => ({ id: params.id, q: query.get("q") }));
server.route<{ name?: string }>("POST", "/api/t/items", ({ body }) => {
  if (!body.name) throw new HttpError(400, "name is required");
  return { created: body.name };
});
server.route("GET", "/api/t/conflict", () => {
  throw new HttpError(409, "exists", { error: "office_exists", office_id: "o1" });
});
server.route("GET", "/api/t/boom", () => { throw new Error("kaboom"); });
server.route("POST", "/api/t/mark-all", ({ body }) => ({ got: body }), { requireBody: true });
server.route("GET", "/api/t/async", async () => ({ ok: await Promise.resolve(true) }));
server.route("GET", "/api/t/self", ({ req, res }) => { server.json(res, 201, { raw: true }, req); });
server.route("GET", "/api/t/self-big", ({ req, res }) => {
  server.json(res, 201, { big: "x".repeat(5000) }, req); // over GZIP_THRESHOLD: written from a callback
});
server.route("DELETE", "/api/t/items/:id", () => undefined);
server.get("/api/t/plain", () => { throw new HttpError(404, "nope"); });

beforeAll(async () => {
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => { await server.stop(); });

describe("server.route", () => {
  it("hands over params and query and returns the value as a 200", async () => {
    const r = await fetch(`${base}/api/t/items/abc?q=x`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: "abc", q: "x" });
  });

  it("parses the JSON body", async () => {
    const r = await fetch(`${base}/api/t/items`, { method: "POST", body: JSON.stringify({ name: "n" }) });
    expect(await r.json()).toEqual({ created: "n" });
  });

  it("treats an empty body as {} so validation answers, not the parser", async () => {
    const r = await fetch(`${base}/api/t/items`, { method: "POST" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "name is required" });
  });

  it("answers a malformed body with 400", async () => {
    const r = await fetch(`${base}/api/t/items`, { method: "POST", body: "{nope" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("with requireBody, rejects an empty body but accepts a literal {}", async () => {
    const empty = await fetch(`${base}/api/t/mark-all`, { method: "POST" });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "Invalid JSON body" });
    const literal = await fetch(`${base}/api/t/mark-all`, { method: "POST", body: "{}" });
    expect(await literal.json()).toEqual({ got: {} });
  });

  it("maps HttpError to its status and custom body", async () => {
    const r = await fetch(`${base}/api/t/conflict`);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "office_exists", office_id: "o1" });
  });

  it("maps any other error to a 500 with String(err)", async () => {
    const r = await fetch(`${base}/api/t/boom`);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "Error: kaboom" });
  });

  it("awaits async handlers", async () => {
    expect(await (await fetch(`${base}/api/t/async`)).json()).toEqual({ ok: true });
  });

  it("leaves a response the handler wrote itself alone", async () => {
    const r = await fetch(`${base}/api/t/self`);
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ raw: true });
  });

  it("does not answer twice when the handler's own response is gzipped asynchronously", async () => {
    const r = await fetch(`${base}/api/t/self-big`, { headers: { "Accept-Encoding": "gzip" } });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { big: string }).big.length).toBe(5000);
  });

  it("answers 204 when the handler returns nothing", async () => {
    const r = await fetch(`${base}/api/t/items/abc`, { method: "DELETE" });
    expect(r.status).toBe(204);
  });
});

describe("dispatcher", () => {
  it("maps HttpError thrown by a plain handler to its status", async () => {
    const r = await fetch(`${base}/api/t/plain`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "nope" });
  });
});

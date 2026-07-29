/**
 * Tests for the `frontend.pages` manifest block (extension frontend page
 * bundles) and the `/*` wildcard support in KernelHttpServer's router
 * (used by GET /ext-assets/:slug/*).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { validateManifest } from "../src/modules/extensions/schema.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";

const baseValid = {
  $schema: "kernl://extension/v1",
  id: "com.example.books",
  slug: "books",
  name: "Books",
  version: "1.0.0",
  type: "module",
  description: "Books extension with a frontend page bundle.",
  author: "Example",
  license: "MIT",
  category: "leisure",
  backend: { entry: "backend/entry.js" },
};

describe("frontend.pages manifest block", () => {
  it("accepts a valid pages array", () => {
    const r = validateManifest({
      ...baseValid,
      frontend: {
        pages: [{ view: "books", entry: "frontend/entry.js", title: "Books" }],
      },
    });
    expect(r.ok).toBe(true);
  });

  it("accepts pages without title", () => {
    const r = validateManifest({
      ...baseValid,
      frontend: { pages: [{ view: "books", entry: "frontend/entry.js" }] },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects entry with .. path traversal", () => {
    const r = validateManifest({
      ...baseValid,
      frontend: { pages: [{ view: "books", entry: "frontend/../../secret.js" }] },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects absolute entry path", () => {
    const r = validateManifest({
      ...baseValid,
      frontend: { pages: [{ view: "books", entry: "/etc/passwd" }] },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects backslashes in entry", () => {
    const r = validateManifest({
      ...baseValid,
      frontend: { pages: [{ view: "books", entry: "frontend\\entry.js" }] },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects missing view", () => {
    const r = validateManifest({
      ...baseValid,
      frontend: { pages: [{ entry: "frontend/entry.js" }] },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects uppercase / non-URL-segment view", () => {
    const r = validateManifest({
      ...baseValid,
      frontend: { pages: [{ view: "My Books", entry: "frontend/entry.js" }] },
    });
    expect(r.ok).toBe(false);
  });
});

describe("http router /* wildcard", () => {
  const cfg = {
    dashboard: { port: 0, bind: "127.0.0.1" },
    auth: { token: "" },
    cors: { allowedOrigins: [] },
  } as unknown as KernelConfig;

  const server = new KernelHttpServer({ config: cfg });
  server.get("/ext-assets/:slug/*", (req, res) => {
    const params = (req as unknown as { params: Record<string, string> }).params;
    server.json(res, 200, { matched: true, ...params });
  });

  afterAll(async () => {
    await server.stop();
  });

  it("matches multi-segment paths, capturing params.rest", async () => {
    const started = await server.start();
    expect(started).toBe(true);
    const addr = server.nodeServer!.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const r = await fetch(`http://127.0.0.1:${port}/ext-assets/x/a/b.js`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { matched: boolean; slug: string; rest: string };
    expect(body.matched).toBe(true);
    expect(body.slug).toBe("x");
    expect(body.rest).toBe("a/b.js");

    // Single-segment rest also matches.
    const r2 = await fetch(`http://127.0.0.1:${port}/ext-assets/books/entry.js`);
    const body2 = (await r2.json()) as { slug: string; rest: string };
    expect(body2.slug).toBe("books");
    expect(body2.rest).toBe("entry.js");

    // Encoded-slash traversal ("..%2f") survives WHATWG URL normalization
    // as a single segment and is captured verbatim — handlers must decode
    // and containment-check before touching the filesystem. (Plain "../"
    // and "%2e%2e/" segments are already normalized away by URL parsing
    // and never reach the router.)
    const r3 = await fetch(
      `http://127.0.0.1:${port}/ext-assets/books/..%2fsecret.js`,
    );
    const body3 = (await r3.json()) as { rest: string };
    expect(body3.rest).toBe("..%2fsecret.js");
  });
});

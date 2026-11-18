import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { wrapperDir } from "../src/core/sandbox/drivers/docker-driver.js";

// The per-run scripts live beside the kernel's database. Fixed to /app/data,
// every sandboxed run on an install outside a container failed with EACCES.

describe("wrapperDir", () => {
  it("is /app/data/.claude-wrappers in the image", () => {
    expect(wrapperDir({ SQLITE_PATH: "/app/data/kernel.db" })).toBe("/app/data/.claude-wrappers");
  });

  it("follows the data dir of a packaged install", () => {
    expect(wrapperDir({ SQLITE_PATH: "/home/u/.local/share/kernl/data/kernel.db" }))
      .toBe("/home/u/.local/share/kernl/data/.claude-wrappers");
  });

  it("falls back to data/ under the working directory, like the database", () => {
    expect(wrapperDir({})).toBe(resolve("data", ".claude-wrappers"));
  });
});

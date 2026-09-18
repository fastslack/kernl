import { describe, it, expect } from "bun:test";
import { log } from "../src/core/logger.js";

// `log.error(msg, err)` is the most common call shape in the kernel (hundreds
// of call sites). An Error has no enumerable own properties, so plain
// JSON.stringify printed it as `{}` and every one of those logs lost the
// message and the stack.

function captureStderr(fn: () => void): string {
  const original = process.stderr.write;
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

describe("log data serialization", () => {
  it("keeps the message and stack of an Error passed as data", () => {
    const out = captureStderr(() => log.error("save failed", new Error("disk full")));
    expect(out).toContain("disk full");
    expect(out).toContain('"stack"');
  });

  it("keeps an Error nested inside an object, and its code", () => {
    const cause = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    const out = captureStderr(() => log.warn("retrying", { attempt: 2, cause }));
    expect(out).toContain('"attempt":2');
    expect(out).toContain("connect refused");
    expect(out).toContain("ECONNREFUSED");
  });

  it("prints plain data as JSON, as before", () => {
    const out = captureStderr(() => log.info("synced", { items: 3 }));
    expect(out).toContain('{"items":3}');
  });

  it("never throws on data JSON cannot represent", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    let out = "";
    expect(() => { out = captureStderr(() => log.error("bad payload", loop)); }).not.toThrow();
    expect(out).toContain("bad payload");
  });
});

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  chunkCount, chunkRange, emptyBitmap, setBit, hasBit, missingChunks, isComplete,
  bitmapToB64, bitmapFromB64, sha256Hex, sha256File, EMPTY_SHA256,
} from "../src/core/social-net/file-lane/chunks.js";
import { CHUNK_SIZE, retryDelayMs, pollDelayMs } from "../src/core/social-net/file-lane/limits.js";
import { sanitizeFileName, uniquePath, incomingDir } from "../src/core/social-net/file-lane/paths.js";

describe("chunks", () => {
  it("counts and ranges parts, including the short last one and empty files", () => {
    expect(chunkCount(0)).toBe(0);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(CHUNK_SIZE)).toBe(1);
    expect(chunkCount(CHUNK_SIZE + 1)).toBe(2);
    expect(chunkRange(CHUNK_SIZE + 10, 1)).toEqual({ start: CHUNK_SIZE, end: CHUNK_SIZE + 10 });
  });

  it("tracks parts in a bitmap that survives base64", () => {
    const bm = emptyBitmap(10);
    setBit(bm, 0); setBit(bm, 9);
    const back = bitmapFromB64(bitmapToB64(bm));
    expect(hasBit(back, 9)).toBe(true);
    expect(missingChunks(back, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(isComplete(back, 10)).toBe(false);
    for (let k = 0; k < 10; k++) setBit(back, k);
    expect(isComplete(back, 10)).toBe(true);
    expect(isComplete(emptyBitmap(0), 0)).toBe(true);
  });

  it("hashes buffers and files the same way", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fl-"));
    const p = join(dir, "a.txt");
    writeFileSync(p, "hola");
    expect(await sha256File(p)).toBe(sha256Hex(new TextEncoder().encode("hola")));
    expect(sha256Hex(new Uint8Array())).toBe(EMPTY_SHA256);
  });

  it("backs off retries up to an hour and polls up to 30 s", () => {
    expect(retryDelayMs(0)).toBe(30_000);
    expect(retryDelayMs(20)).toBe(3_600_000);
    expect(pollDelayMs(0)).toBe(2_000);
    expect(pollDelayMs(50)).toBe(30_000);
  });
});

describe("paths", () => {
  it("keeps names inside the folder and readable", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\win\\boot.ini")).toBe("boot.ini");
    expect(sanitizeFileName("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFileName("a\u0000b<>:\"|?*.txt")).toBe("ab_______.txt");
    expect(sanitizeFileName("  .hidden.  ")).toBe("hidden");
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("año 📷.jpg")).toBe("año 📷.jpg");
    const long = sanitizeFileName("x".repeat(300) + ".pdf");
    expect(long.length).toBe(200);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("numbers collisions, counting in-flight .part files", () => {
    const taken = new Set(["/d/a.txt", "/d/a (2).txt.part"]);
    expect(uniquePath("/d", "a.txt", (p) => taken.has(p))).toBe("/d/a (3).txt");
    expect(uniquePath("/d", "b", (p) => taken.has(p))).toBe("/d/b");
  });

  it("builds the incoming folder per friend and day", () => {
    expect(incomingDir("/data", "Mac M4", new Date("2026-10-06T12:00:00Z"))).toBe("/data/transfers/incoming/Mac M4/2026-10-06");
  });
});

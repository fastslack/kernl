import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { CHUNK_SIZE } from "./limits.js";

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function chunkCount(size: number): number {
  return size <= 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
}

/** Byte range of part k; `end` is exclusive. */
export function chunkRange(size: number, k: number): { start: number; end: number } {
  const start = k * CHUNK_SIZE;
  return { start, end: Math.min(start + CHUNK_SIZE, size) };
}

export function emptyBitmap(n: number): Uint8Array {
  return new Uint8Array(Math.ceil(n / 8));
}

export function setBit(bm: Uint8Array, k: number): void {
  bm[k >> 3] |= 1 << (k & 7);
}

export function hasBit(bm: Uint8Array, k: number): boolean {
  return (bm[k >> 3] & (1 << (k & 7))) !== 0;
}

export function missingChunks(bm: Uint8Array, n: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) if (!hasBit(bm, k)) out.push(k);
  return out;
}

export function isComplete(bm: Uint8Array, n: number): boolean {
  return missingChunks(bm, n).length === 0;
}

export function bitmapToB64(bm: Uint8Array): string {
  return Buffer.from(bm).toString("base64");
}

export function bitmapFromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Streaming hash, so a 2 GiB file never sits in memory. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

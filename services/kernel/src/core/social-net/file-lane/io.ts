import { open, rename, mkdir } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";

/** Create (or keep) the .part file at its final size; sparse where the FS allows. */
export async function preparePart(path: string, size: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const fh = await open(path, "a");
  try { await fh.truncate(size); } finally { await fh.close(); }
}

export async function writeAt(path: string, offset: number, data: Uint8Array): Promise<void> {
  const fh = await open(path, "r+");
  try { await fh.write(data, 0, data.length, offset); } finally { await fh.close(); }
}

export async function finalize(partPath: string, finalPath: string): Promise<void> {
  await rename(partPath, finalPath);
}

/** Free bytes on the filesystem holding `dir` (its nearest existing parent). */
export function freeBytes(dir: string): number {
  let d = dir;
  for (;;) {
    try { const s = statfsSync(d); return s.bavail * s.bsize; } catch { const up = dirname(d); if (up === d) return 0; d = up; }
  }
}

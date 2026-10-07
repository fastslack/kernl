import { existsSync } from "node:fs";
import { join, extname } from "node:path";

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_NAME = 200;

/**
 * A received name as something safe to write: no directories, no control
 * characters, nothing Windows refuses, at most 200 characters with the
 * extension kept. Unicode stays — "año 📷.jpg" is a fine name.
 */
export function sanitizeFileName(name: string): string {
  let n = name.split(/[\\/]/).pop() ?? "";
  n = n.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_");
  n = n.replace(/^[\s.]+|[\s.]+$/g, "");
  if (!n) return "file";
  if (RESERVED.test(n)) n = `_${n}`;
  if (n.length > MAX_NAME) {
    const ext = extname(n).slice(0, 20);
    n = n.slice(0, MAX_NAME - ext.length) + ext;
  }
  return n;
}

/** `dir/name`, or `dir/name (2).ext`… when it, or its in-flight `.part`, exists. */
export function uniquePath(dir: string, name: string, exists: (p: string) => boolean = existsSync): string {
  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; ; i++) {
    const candidate = join(dir, i === 1 ? name : `${base} (${i})${ext}`);
    if (!exists(candidate) && !exists(`${candidate}.part`)) return candidate;
  }
}

export function incomingDir(dataDir: string, friendLabel: string, date: Date = new Date()): string {
  return join(dataDir, "transfers", "incoming", sanitizeFileName(friendLabel), date.toISOString().slice(0, 10));
}

export function outgoingDir(dataDir: string, id: string): string {
  return join(dataDir, "transfers", "outgoing", sanitizeFileName(id));
}

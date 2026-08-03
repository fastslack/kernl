/**
 * The stacks we ship must run authenticated.
 *
 * `KERNEL_ALLOW_UNAUTH=1` turns off the `/api` and `/mcp` auth gates entirely
 * (http-server.ts and server.ts both key on a non-empty token). It once lived
 * in the public compose file, justified by the dashboard being published on
 * 127.0.0.1 — but loopback is not a trust boundary against a browser: any page
 * the user has open can reach an open localhost API. Combined with a wildcard
 * CORS header that was a drive-by read and write of the whole kernel.
 *
 * The flag stays available as a local-development escape hatch; it must not
 * reappear in a shipped compose file.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SHIPPED_COMPOSE = ["docker-compose.yml", "docker-compose.full.yml"];

describe("shipped docker stacks", () => {
  for (const file of SHIPPED_COMPOSE) {
    it(`${file} does not disable authentication`, () => {
      const path = resolve(REPO_ROOT, file);
      if (!existsSync(path)) return; // stack not present in this checkout
      const text = readFileSync(path, "utf-8");
      // Match only an active setting — a commented mention explaining why the
      // flag is absent is fine, and is exactly what the file carries today.
      const active = text
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .filter((line) => /KERNEL_ALLOW_UNAUTH/.test(line));
      expect(active).toEqual([]);
    });
  }
});

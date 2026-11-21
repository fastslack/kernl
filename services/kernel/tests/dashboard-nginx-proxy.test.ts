/**
 * The dashboard's nginx configs, read as text.
 *
 * A `proxy_pass` that names its upstream through a variable and gives a URI
 * sends that URI as written and drops the request's query string. The
 * broker's socket (`/mtw`) carries the kernel token in that query, and
 * mtwRequest >= 0.5.0 refuses a handshake without it, so a proxy_pass of that
 * shape has to pass the query on itself (`$is_args$args`) or forward the
 * original `$request_uri`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD = join(import.meta.dir, "..", "..", "dashboard");
const CONFIGS = ["nginx.conf", "nginx.public.conf"];

/** proxy_pass targets with a variable before a URI path, e.g. http://$up/ws. */
function variableUriTargets(conf: string): string[] {
  return [...conf.matchAll(/^\s*proxy_pass\s+([^;]+);/gm)]
    .map((m) => m[1].trim())
    .filter((target) => {
      const afterScheme = target.replace(/^https?:\/\//, "");
      const slash = afterScheme.indexOf("/");
      return slash > 0 && afterScheme.slice(0, slash).includes("$");
    });
}

describe("dashboard nginx proxy_pass keeps the query", () => {
  for (const name of CONFIGS) {
    it(`${name}: a variable upstream with a URI passes the query on`, () => {
      const conf = readFileSync(join(DASHBOARD, name), "utf8");
      for (const target of variableUriTargets(conf)) {
        expect(target, target).toMatch(/\$is_args\$args$|\$request_uri$/);
      }
    });
  }

  it("nginx.public.conf sends the /mtw token through to the broker", () => {
    const conf = readFileSync(join(DASHBOARD, "nginx.public.conf"), "utf8");
    const block = conf.slice(conf.indexOf("location /mtw"));
    const target = block.match(/proxy_pass\s+([^;]+);/)?.[1] ?? "";
    expect(target).toBe("http://$mtw_upstream/ws$is_args$args");
  });
});

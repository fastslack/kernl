/**
 * The bind downgrade must happen where the FINAL auth token is known.
 *
 * Order of events at boot: `loadConfig()` reads the environment, then
 * `initDatabases()` generates and persists an auth token when none was
 * configured. If loadConfig applies the fail-closed downgrade itself, it does
 * so while the token is still empty and rewrites the operator's
 * `KERNEL_DASHBOARD_BIND=0.0.0.0` to `127.0.0.1` — permanently. The token then
 * appears, authentication is on, but the kernel is stuck on loopback and every
 * request proxied from the nginx sibling container 502s.
 *
 * So loadConfig records the configured bind verbatim and `KernelHttpServer`
 * (which already re-runs `resolveSecureBind`) is the single place that decides,
 * against the token actually in force.
 */

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { loadConfig } from "../src/core/config.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";

const saved = {
  bind: process.env.KERNEL_DASHBOARD_BIND,
  token: process.env.KERNEL_AUTH_TOKEN,
  unauth: process.env.KERNEL_ALLOW_UNAUTH,
};

afterAll(() => {
  restore("KERNEL_DASHBOARD_BIND", saved.bind);
  restore("KERNEL_AUTH_TOKEN", saved.token);
  restore("KERNEL_ALLOW_UNAUTH", saved.unauth);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  // Empty (not absent) so dotenv treats the key as already set and the repo's
  // own .env cannot leak a real token into these assertions.
  process.env.KERNEL_AUTH_TOKEN = "";
  delete process.env.KERNEL_ALLOW_UNAUTH;
});

describe("loadConfig bind", () => {
  it("records the configured bind verbatim, leaving the decision to the bind site", () => {
    process.env.KERNEL_DASHBOARD_BIND = "0.0.0.0";
    expect(loadConfig().dashboard.bind).toBe("0.0.0.0");
  });
});

describe("KernelHttpServer bind decision", () => {
  const servers: KernelHttpServer[] = [];
  afterAll(async () => {
    for (const s of servers) await s.stop();
  });

  async function boundAddress(token: string): Promise<string> {
    const cfg = {
      dashboard: { port: 0, bind: "0.0.0.0" },
      auth: { token },
      cors: { allowedOrigins: [] },
    } as unknown as KernelConfig;
    const server = new KernelHttpServer({ config: cfg });
    servers.push(server);
    await server.start();
    const addr = server.nodeServer!.address();
    return typeof addr === "object" && addr ? addr.address : "";
  }

  it("honors a non-loopback bind once a token is in force (the generated-token case)", async () => {
    expect(await boundAddress("a-token-generated-at-boot-32-chars-long")).toBe("0.0.0.0");
  });

  it("still forces loopback when the token is empty", async () => {
    expect(await boundAddress("")).toBe("127.0.0.1");
  });
});

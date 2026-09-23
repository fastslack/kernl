/**
 * The GitHub, GitLab and Gitea channels share one connection store, one
 * request loop and one set of connection tools (automation/_lib/forge).
 * Credentials used to sit in plaintext columns; they are sealed at rest now,
 * and rows written before that get sealed on startup.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/sdk/migrations.js";
import { generateKey } from "../src/sdk/crypto.js";
import { giteaChannelMigrations } from "../assets/extensions/automation/gitea-channel/_module/migrations.js";
import { githubChannelMigrations } from "../assets/extensions/automation/github-channel/_module/migrations.js";
import { GiteaConnectionsService } from "../assets/extensions/automation/gitea-channel/_module/connections-service.js";
import { GitHubConnectionsService } from "../assets/extensions/automation/github-channel/_module/connections-service.js";
import { GiteaRepoProvider } from "../assets/extensions/automation/gitea-channel/_module/provider.js";
import { GitHubRepoProvider } from "../assets/extensions/automation/github-channel/_module/provider.js";
import { giteaChannelTools } from "../assets/extensions/automation/gitea-channel/_module/tools.js";

const key = generateKey();
let db: InstanceType<typeof Database>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, "ext:gitea-channel", giteaChannelMigrations);
  runMigrations(db, "ext:github-channel", githubChannelMigrations);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
});

const rawToken = (id: string) =>
  (db.prepare("SELECT token FROM gitea_connections WHERE id = ?").get(id) as { token: string }).token;

describe("forge connection store", () => {
  it("seals the token at rest and hands it back in the clear", () => {
    const store = new GiteaConnectionsService(db, key);
    const c = store.add({ name: "cb", host: "https://codeberg.org/", token: "secret-token" });
    expect(c.host).toBe("https://codeberg.org");
    expect(c.token).toBe("secret-token");
    expect(rawToken(c.id)).not.toBe("secret-token");
    expect(store.getByName("cb")?.token).toBe("secret-token");
  });

  it("seals rows written in plaintext before, on startup", () => {
    const plain = new GiteaConnectionsService(db, "").add({ name: "old", host: "https://x", token: "legacy" });
    expect(rawToken(plain.id)).toBe("legacy");
    const store = new GiteaConnectionsService(db, key);
    expect(rawToken(plain.id)).not.toBe("legacy");
    expect(store.get(plain.id)?.token).toBe("legacy");
  });

  it("keeps the validation messages", () => {
    const store = new GitHubConnectionsService(db, key);
    expect(() => store.add({ name: "a", app_id: "1", installation_id: "2", private_key_pem: "nope" }))
      .toThrow("private_key_pem must be a PEM-encoded RSA key");
  });

  it("soft-deletes and records test results", () => {
    const store = new GiteaConnectionsService(db, key);
    const c = store.add({ name: "cb", host: "https://x", token: "t" });
    store.recordTest(c.id, false, "boom");
    expect(store.get(c.id)).toMatchObject({ last_test_ok: 0, last_test_error: "boom" });
    expect(store.remove(c.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });
});

describe("forge credentials under a changed or missing key", () => {
  const unreadable =
    "Gitea connection cb: stored credentials can't be decrypted with the current KERNEL_ENCRYPTION_KEY — re-add the connection";

  it("a rotated key flags the connection instead of sending the ciphertext", async () => {
    const c = new GiteaConnectionsService(db, key).add({ name: "cb", host: "https://x", token: "secret-token" });
    const sealed = rawToken(c.id);
    const store = new GiteaConnectionsService(db, generateKey());
    // Startup does not wrap the old ciphertext in a second layer.
    expect(rawToken(c.id)).toBe(sealed);
    const conn = store.get(c.id)!;
    expect(conn.credentials_unreadable).toBe(true);
    expect(conn.token).toBe("");

    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    const provider = new GiteaRepoProvider(store);
    expect(await provider.testConnection(c.id)).toEqual({ ok: false, detail: unreadable });
    await expect(provider.fetchItem("o/r", 1, c.id)).rejects.toThrow(unreadable);
    expect(() => provider.assertConnection(c.id)).toThrow(unreadable);
    expect(calls).toBe(0);

    const tools = giteaChannelTools(store, provider);
    const list = (await tools.find((t) => t.name === "kernel_gitea_connections_list")!.handler({})).content[0].text;
    expect(list).toContain("credentials=unreadable");
    expect(list).not.toContain(sealed);
  });

  it("a missing key flags sealed credentials too", () => {
    const c = new GiteaConnectionsService(db, key).add({ name: "cb", host: "https://x", token: "secret-token" });
    const conn = new GiteaConnectionsService(db, "").get(c.id)!;
    expect(conn.credentials_unreadable).toBe(true);
    expect(conn.token).toBe("");
  });

  it("legacy plaintext keeps working: as given without a key, sealed on boot with one", () => {
    const hex = "0123456789abcdef0123456789abcdef01234567"; // a Gitea-style token
    const plain = new GiteaConnectionsService(db, "");
    const c = plain.add({ name: "cb", host: "https://x", token: hex });
    expect(rawToken(c.id)).toBe(hex);
    expect(plain.get(c.id)).toMatchObject({ token: hex });
    expect(plain.get(c.id)?.credentials_unreadable).toBeUndefined();
    const store = new GiteaConnectionsService(db, key);
    expect(rawToken(c.id)).not.toBe(hex);
    expect(store.get(c.id)?.token).toBe(hex);
    expect(store.get(c.id)?.credentials_unreadable).toBeUndefined();
  });
});

describe("forge tools", () => {
  it("answer with the same text as before", async () => {
    const store = new GiteaConnectionsService(db, key);
    const tools = giteaChannelTools(store, new GiteaRepoProvider(store));
    const call = async (name: string, args: unknown) => (await tools.find((t) => t.name === name)!.handler(args)).content[0].text;
    expect(await call("kernel_gitea_connections_list", {})).toBe("No Gitea connections configured.");
    const added = await call("kernel_gitea_connections_add", { name: "cb", host: "https://x", token: "t" });
    expect(added).toMatch(/^Added Gitea connection \*\*cb\*\* \(id .+, host https:\/\/x\)\.$/);
    expect(await call("kernel_gitea_connections_list", {})).toMatch(/— host=https:\/\/x, untested$/);
  });
});

describe("forge requests", () => {
  it("waits out a rate limit and retries", async () => {
    const store = new GiteaConnectionsService(db, key);
    const c = store.add({ name: "cb", host: "https://x", token: "t" });
    const auth: string[] = [];
    let calls = 0;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      auth.push((init.headers as Record<string, string>).Authorization);
      calls++;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } })
        : Response.json({ id: 7, login: "bot" });
    }) as typeof fetch;
    const r = await new GiteaRepoProvider(store).testConnection(c.id);
    expect(r).toEqual({ ok: true, detail: "OK — user id=7 (bot) at https://x" });
    expect(calls).toBe(2);
    expect(auth[0]).toBe("token t"); // the decrypted token went over the wire
  });

  it("GitHub drops an expired installation token on 401 and retries with a fresh one", async () => {
    const pem = (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    const store = new GitHubConnectionsService(db, key);
    const c = store.add({ name: "gh", app_id: "1", installation_id: "2", private_key_pem: pem });
    let minted = 0;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/access_tokens")) {
        minted++;
        return Response.json({ token: `tok${minted}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      const authz = (init.headers as Record<string, string>).Authorization;
      seen.push(authz);
      return authz === "Bearer tok1" ? new Response("expired", { status: 401 }) : Response.json({ id: 1, slug: "kernl" });
    }) as typeof fetch;
    const r = await new GitHubRepoProvider(store).testConnection(c.id);
    expect(r).toEqual({ ok: true, detail: "OK — app id=1 (kernl)" });
    expect(seen).toEqual(["Bearer tok1", "Bearer tok2"]);
  });
});

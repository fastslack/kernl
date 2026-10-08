/**
 * Cinema publishes on two lanes: subtitle announcements point at bytes this
 * kernel hosts, so they are signed with the instance key; public directories
 * are signed by the persona and must not carry a link to the kernel.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { Event as NostrEvent } from "nostr-tools/core";
import { NostrIdentity } from "../src/sdk/nostr-identity.js";
import type { ModuleContext } from "../src/core/types.js";
import { createCinemaModule } from "../assets/extensions/leisure/cinema/_module/index.js";

const instance = NostrIdentity.fromEd25519Seed(new Uint8Array(32).fill(3));
const persona = NostrIdentity.fromEd25519Seed(new Uint8Array(32).fill(4));
const PUBLIC_URL = "https://kernl.example.org";

function fakePool(published: NostrEvent[]) {
  return {
    publish: async (ev: NostrEvent) => {
      published.push(ev);
      return [{ relay: "wss://fake", ok: true }];
    },
    querySync: async () => [],
  } as never;
}

async function wiredCinema(published: NostrEvent[]) {
  const mod = createCinemaModule();
  await mod.initialize({ sqlite: new Database(":memory:"), config: {} } as unknown as ModuleContext);
  mod.setNostrIdentity(persona, fakePool(published), instance);
  return mod;
}

const savedUrl = process.env.DASHBOARD_PUBLIC_URL;
afterEach(() => {
  if (savedUrl === undefined) delete process.env.DASHBOARD_PUBLIC_URL;
  else process.env.DASHBOARD_PUBLIC_URL = savedUrl;
});

describe("cinema nostr identities", () => {
  it("signs subtitle announcements with the instance key, not the persona", async () => {
    const published: NostrEvent[] = [];
    const mod = await wiredCinema(published);
    const nostr = mod.getDiscoveryRegistry()!.list().find((p) => p.id === "nostr")!;

    await nostr.publish({
      identifier: "some-film",
      srcLang: "en",
      tgtLang: "es",
      engine: "whisper",
      engineVersion: "v1",
      magnet: "",
      webseedUrl: `${PUBLIC_URL}/api/cinema/media/subs/file?key=k`,
      sha256: "",
      sizeBytes: 1,
      content: "",
    });

    expect(published).toHaveLength(1);
    expect(published[0].pubkey).toBe(instance.pubkeyHex);
    expect(published[0].pubkey).not.toBe(persona.pubkeyHex);
  });

  it("announces a public directory under the persona with no link to the kernel", async () => {
    process.env.DASHBOARD_PUBLIC_URL = PUBLIC_URL;
    const published: NostrEvent[] = [];
    const mod = await wiredCinema(published);
    const dirs = mod.getDirectoriesService()!;
    const dir = dirs.create({
      owner_pubkey: persona.pubkeyHex,
      title: "Cine argentino",
      description: "lo mejor",
      visibility: "public",
    });

    await mod.getDirectoriesProvider()!.publish(dir);
    // The kind-1 note goes out fire-and-forget after the directory event.
    await new Promise((r) => setTimeout(r, 10));

    const note = published.find((e) => e.kind === 1);
    expect(note).toBeDefined();
    expect(note!.pubkey).toBe(persona.pubkeyHex);
    expect(note!.content).toContain("Cine argentino");
    expect(note!.content).not.toContain(PUBLIC_URL);
    for (const ev of published) {
      expect(JSON.stringify(ev)).not.toContain(PUBLIC_URL);
    }
  });
});

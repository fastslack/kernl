/**
 * Friends-only directories: what a friend may see, what never leaves, and how
 * a pulled directory is recorded.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import {
  CinemaDirectoriesService,
  type CinemaDirectory,
} from "../assets/extensions/leisure/cinema/_module/directories-service.js";
import { NostrDirectoriesProvider } from "../assets/extensions/leisure/cinema/_module/discovery/nostr-directories-provider.js";

const OWNER = "a".repeat(64);

function makeService() {
  const db = new Database(":memory:");
  runMigrations(db, "cinema", cinemaMigrations);
  return new CinemaDirectoriesService(db);
}

describe("friends-only directories", () => {
  let svc: CinemaDirectoriesService;

  beforeEach(() => {
    svc = makeService();
  });

  it("accepts the friends visibility", () => {
    const d = svc.create({ owner_pubkey: OWNER, title: "Cine argentino", visibility: "friends" });
    expect(d.visibility).toBe("friends");
    expect(svc.get(d.id)!.visibility).toBe("friends");
  });

  it("shows a friend the public, unlisted and friends lists — never private", () => {
    svc.create({ owner_pubkey: OWNER, title: "abierto", visibility: "public" });
    svc.create({ owner_pubkey: OWNER, title: "sin listar", visibility: "unlisted" });
    svc.create({ owner_pubkey: OWNER, title: "para amigos", visibility: "friends" });
    svc.create({ owner_pubkey: OWNER, title: "solo mío", visibility: "private" });

    const titles = svc.listForFriend().map((d) => d.title);
    expect(titles).toContain("abierto");
    expect(titles).toContain("sin listar");
    expect(titles).toContain("para amigos");
    expect(titles).not.toContain("solo mío");
  });

  it("never publishes a friends or private directory to a relay", async () => {
    const provider = new NostrDirectoriesProvider(null);
    for (const visibility of ["friends", "private"] as const) {
      const dir = svc.create({ owner_pubkey: OWNER, title: `x-${visibility}`, visibility });
      // The guard fires before any identity or relay is even consulted, which
      // is the point: there is no configuration in which this leaks.
      await expect(provider.publish(dir)).rejects.toThrow(visibility);
    }
  });

  it("records a directory pulled from a friend with its provenance", () => {
    const incoming: CinemaDirectory = {
      id: "dir-from-friend",
      owner_pubkey: "b".repeat(64),
      title: "lo que ve mi amigo",
      description: "",
      category: "",
      cover_identifier: "",
      visibility: "friends",
      items: [{ identifier: "movie-1", added_at: new Date().toISOString() }],
      collaborators: [],
      origin: "federated",
      nostr_event_id: "",
      version: 3,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      published_at: null,
    } as unknown as CinemaDirectory;

    expect(svc.upsertFromFriend(incoming, "npub1friend")).toBe("created");
    const stored = svc.get("dir-from-friend")!;
    expect(stored.origin).toBe("federated");
    expect(stored.items).toHaveLength(1);
  });

  it("takes a newer version and ignores an older one", () => {
    const base = {
      id: "d1",
      owner_pubkey: "b".repeat(64),
      title: "v1",
      description: "",
      category: "",
      cover_identifier: "",
      visibility: "friends",
      items: [],
      collaborators: [],
      origin: "federated",
      nostr_event_id: "",
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      published_at: null,
    } as unknown as CinemaDirectory;

    expect(svc.upsertFromFriend(base, "npub1friend")).toBe("created");
    expect(svc.upsertFromFriend({ ...base, title: "v2", version: 2 }, "npub1friend")).toBe("updated");
    expect(svc.get("d1")!.title).toBe("v2");
    // A replayed older copy must not roll us back.
    expect(svc.upsertFromFriend({ ...base, title: "v0", version: 1 }, "npub1friend")).toBe("ignored");
    expect(svc.get("d1")!.title).toBe("v2");
  });

  it("refuses to let a friend overwrite a directory we own", () => {
    const mine = svc.create({ owner_pubkey: OWNER, title: "mío", visibility: "friends" });
    const forged = {
      ...mine,
      title: "secuestrado",
      version: 999,
      origin: "federated",
    } as unknown as CinemaDirectory;
    expect(svc.upsertFromFriend(forged, "npub1attacker")).toBe("ignored");
    expect(svc.get(mine.id)!.title).toBe("mío");
  });
});

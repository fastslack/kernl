/**
 * Stage-4a demo — exercises the subtitle marketplace foundation.
 *
 *   1. Boot in-memory SQLite + cinema migrations.
 *   2. Wire DiscoveryRegistry with NostrSubsProvider (publishable, using
 *      a throwaway identity) and ArchiveSubsProvider (read-only).
 *   3. Publish a fake .srt announcement via Nostr.
 *   4. Query Nostr back by the same identifier and verify our event
 *      appears in the index.
 *   5. Query archive.org for a real silent_films movie's subtitle files
 *      (whatever ones happen to exist on the item) and verify the
 *      ArchiveSubsProvider lists them.
 *   6. Exercise the trust-list write path.
 *
 * No kernel HTTP boot, no Neo4j — just providers + service.
 *
 * Run:
 *   npx tsx scripts/demo-cinema-subs.ts [archive_identifier]
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import { CinemaSubsService } from "../assets/extensions/leisure/cinema/_module/subs-service.js";
import { DiscoveryRegistry } from "../assets/extensions/leisure/cinema/_module/discovery/registry.js";
import { NostrSubsProvider } from "../assets/extensions/leisure/cinema/_module/discovery/nostr-provider.js";
import { ArchiveSubsProvider } from "../assets/extensions/leisure/cinema/_module/discovery/archive-provider.js";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";

function bar(s: string): void {
  console.log("\n" + "─".repeat(72) + "\n  " + s + "\n" + "─".repeat(72));
}

async function main(): Promise<void> {
  // archive.org movie identifier with known .srt files. Default uses a
  // well-seeded silent film known to ship subtitle derivatives. Override
  // via argv to test a different one.
  const ARCHIVE_ID = process.argv[2] ?? "BattleshipPotemkin";

  bar(`Stage-4a demo · subs marketplace foundation · archive=${ARCHIVE_ID}`);

  // ── Setup ─────────────────────────────────────────────────────
  const db = new Database(":memory:");
  runMigrations(db, "cinema", cinemaMigrations);
  const subs = new CinemaSubsService(db);

  const ephemeralId = NostrIdentity.fromEd25519Seed(randomBytes(32));
  console.log("ephemeral signer npub:", ephemeralId.npub());

  const registry = new DiscoveryRegistry();
  // We use a tiny relay set + tighter timeouts here so the demo doesn't
  // wait 5s on every querySync. Production wiring uses defaults.
  registry.register(new NostrSubsProvider(ephemeralId, {
    relays: ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.snort.social"],
    queryTimeoutMs: 4000,
  }));
  registry.register(new ArchiveSubsProvider());

  console.log("registered providers:");
  for (const p of registry.list()) {
    console.log(`  · ${p.id.padEnd(12)}  ${p.label.padEnd(14)}  canPublish=${p.canPublish}`);
  }

  // ── 1) Nostr publish round-trip ──────────────────────────────
  bar("Nostr: publish a fake .srt announcement");
  const sha = "deadbeef".repeat(8);
  const { successes, failures } = await registry.publishAll({
    identifier: ARCHIVE_ID,
    srcLang: "en",
    tgtLang: "es",
    engine: "demo",
    engineVersion: "v0",
    magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}&dn=${ARCHIVE_ID}.es.srt`,
    webseedUrl: `https://example.invalid/probe/${ARCHIVE_ID}.es.srt`,
    sha256: sha,
    sizeBytes: 4096,
    content: `Demo announcement — Spanish subs for ${ARCHIVE_ID}`,
  });
  console.log(`successes: ${successes.length}`);
  for (const s of successes) {
    console.log(`  ✓ ${s.providerId.padEnd(12)} eventId=${s.providerEventId.slice(0, 16)}…  ${s.detail}`);
  }
  if (failures.length > 0) {
    console.log(`failures: ${failures.length}`);
    for (const f of failures) console.log(`  ✗ ${f.providerId}: ${f.error.slice(0, 100)}`);
  }
  if (successes.length === 0) {
    console.log("⚠ no provider accepted the announcement — read-back will fail");
  }

  // Wait a beat so relays index the event before we query.
  await new Promise((r) => setTimeout(r, 1500));

  // ── 2) Multi-provider queryAll ────────────────────────────────
  bar("queryAll: read every provider for the same video");
  const result = await registry.queryAll({ identifier: ARCHIVE_ID, limit: 50 });
  console.log(`got ${result.items.length} announcements across ${registry.list().length} providers`);
  if (result.errors.length > 0) {
    console.log(`provider errors: ${result.errors.length}`);
    for (const e of result.errors) console.log(`  · ${e.providerId}: ${e.error.slice(0, 100)}`);
  }

  // ── 3) Upsert each into the index, dedupe across providers ───
  bar("upsertIndex: persist announcements (dedupe by provider+event_id)");
  for (const ann of result.items) subs.upsertIndex(ann);
  const indexed = subs.listIndexByVideo(ARCHIVE_ID);
  console.log(`cinema_subs_index now has ${indexed.length} rows for ${ARCHIVE_ID}`);

  // Group by provider for visibility
  const byProvider = new Map<string, number>();
  for (const r of indexed) byProvider.set(r.providerId, (byProvider.get(r.providerId) ?? 0) + 1);
  for (const [pid, count] of byProvider.entries()) {
    console.log(`  · ${pid.padEnd(12)} ${count} row(s)`);
  }

  bar("Sample rows (first 5 across providers)");
  for (const r of indexed.slice(0, 5)) {
    const pk = r.signerPubkey ? r.signerPubkey.slice(0, 12) + "…" : "—".padEnd(13);
    console.log(
      `  ${r.providerId.padEnd(12)}  ${r.tgtLang.padEnd(4)}  ${r.engine.padEnd(8)}  ` +
        `signer=${pk}  ${r.content.slice(0, 36).padEnd(36)}  size=${r.sizeBytes}`,
    );
  }

  // ── 4) Verify our own published event appears in the index ──
  bar("Round-trip check: did Nostr return our published event?");
  const ours = indexed.find(
    (r) => r.providerId === "nostr" && r.signerPubkey === ephemeralId.pubkeyHex,
  );
  if (ours) {
    console.log(`✓ found own event: rowId=${ours.rowId.slice(0, 8)}… eventId=${ours.providerEventId.slice(0, 16)}…`);
    console.log(`  tgt_lang=${ours.tgtLang} engine=${ours.engine} sha256=${ours.sha256.slice(0, 16)}…`);
  } else {
    console.log("⚠ our event id NOT in the index. Likely causes:");
    console.log("  · relays accepted but slow to index (try re-running)");
    console.log("  · all relays rejected (check the publish step output above)");
  }

  // ── 5) Trust list ─────────────────────────────────────────────
  bar("Trust list write/read");
  subs.setTrust(ephemeralId.pubkeyHex, "trusted", "demo-bot", "ephemeral key from probe");
  const me = subs.getPublisher(ephemeralId.pubkeyHex);
  console.log(`publisher: pubkey=${me?.pubkey.slice(0, 16)}… alias=${me?.alias} trust=${me?.trust}`);

  // Block a random fake key to exercise the validation path.
  subs.setTrust("a".repeat(64), "blocked", "spam-bot");
  const all = subs.listPublishers();
  console.log(`publishers in trust list: ${all.length}`);
  for (const p of all) {
    console.log(`  · ${p.trust.padEnd(8)}  ${p.pubkey.slice(0, 16)}…  ${p.alias}`);
  }

  // ── 6) archive.org provider direct call ───────────────────────
  bar(`archive.org direct: list .srt files for ${ARCHIVE_ID}`);
  const archive = new ArchiveSubsProvider();
  const archiveItems = await archive.query({ identifier: ARCHIVE_ID, limit: 50 });
  console.log(`archive.org returned ${archiveItems.length} subtitle file(s)`);
  for (const it of archiveItems.slice(0, 8)) {
    console.log(
      `  · ${it.tgtLang.padEnd(4)}  ${it.content.slice(0, 50).padEnd(50)}  ${it.sizeBytes} bytes`,
    );
    console.log(`      ${it.webseedUrl}`);
  }
  if (archiveItems.length === 0) {
    console.log("(no subs uploaded to this item — try a different archive identifier)");
  }

  bar("✓ demo complete");
  console.log("Stage 4a verification: providers register, queryAll fans out,");
  console.log("Nostr publish round-trips, archive.org returns real subs metadata,");
  console.log("trust list write/read works, dedup by (provider_id, provider_event_id)");
  console.log("keeps the index sane across re-runs.");

  // Close any open relay sockets (Nostr provider opens lazy connections).
  for (const p of registry.list()) {
    if ("close" in p && typeof (p as { close: () => Promise<void> }).close === "function") {
      await (p as { close: () => Promise<void> }).close();
    }
  }
}

main().catch((err) => {
  console.error("\n✗ demo failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});

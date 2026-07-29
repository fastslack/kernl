/**
 * Stage-0 probe — Nostr cinema announcement (kind 30078).
 *
 * Verifies the discovery layer end-to-end before we commit to it:
 *   1. We can publish a kind-30078 event with a `#video` tag to the default
 *      relay set.
 *   2. We can query those relays back by `#video=<id>` and read our event.
 *   3. The event survives a relay round-trip (signature, tags intact).
 *
 * Uses an EPHEMERAL identity (random seed) so the real kernel social
 * pubkey never publishes probe garbage.
 *
 * Run:
 *   npx tsx scripts/demo-cinema-nostr.ts
 */

import { randomBytes } from "node:crypto";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { NostrRelayPool, DEFAULT_RELAYS } from "../src/core/nostr/nostr-relay-pool.js";

const KIND = 30078;
// Build a unique #video tag so we don't collide with anyone else's probe.
const VIDEO_ID = `mtwcinema-probe-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;

function bar(s: string): void {
  console.log("\n" + "─".repeat(72) + "\n  " + s + "\n" + "─".repeat(72));
}

async function main(): Promise<void> {
  bar(`Probe · Nostr kind ${KIND} · video tag ${VIDEO_ID}`);
  console.log("relays:");
  for (const r of DEFAULT_RELAYS) console.log("  · " + r);

  // Throwaway identity — DO NOT use the kernel social seed for a probe.
  const id = NostrIdentity.fromEd25519Seed(randomBytes(32));
  console.log("ephemeral npub:", id.npub());

  const pool = new NostrRelayPool(DEFAULT_RELAYS);

  bar("Publish");
  const fakeMagnet = `magnet:?xt=urn:btih:${"a".repeat(40)}&dn=probe.es.srt`;
  const fakeWebseed = "https://example.invalid/probe/probe.es.srt";
  const fakeSha = "deadbeef".repeat(8);

  // Discovery tags — `t` is universally indexed across relays (it's how
  // hashtags work in Nostr). `d` is required by NIP-33 for replaceable
  // kinds and is also indexed. Custom tags like `#video` are NOT indexed
  // by major relays (damus, wine) — they reject filters using them with
  // "bad req: unindexed tag filter". So we use `t` for queries and keep
  // domain-specific tags (src_lang, tgt_lang, …) as opaque payload.
  const TOPIC_GLOBAL = "mtwcinema";
  const TOPIC_VIDEO = `mtwcinema:${VIDEO_ID}`;

  const event = id.signEvent({
    kind: KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", `subs/archive-org/${VIDEO_ID}/en/es/probe/v0`],
      ["t", TOPIC_GLOBAL],
      ["t", TOPIC_VIDEO],
      ["src_lang", "en"],
      ["tgt_lang", "es"],
      ["engine", "probe"],
      ["sha256", fakeSha],
      ["size", "0"],
      ["magnet", fakeMagnet],
      ["webseed", fakeWebseed],
      ["client", "Kernl/cinema-probe"],
    ],
    content: "probe — Spanish subs announcement for an imaginary movie",
  });
  console.log("event id:", event.id);

  const t0 = Date.now();
  const outcomes = await pool.publish(event);
  console.log(`publish completed in ${Date.now() - t0} ms:`);
  for (const o of outcomes) {
    console.log(`  ${o.ok ? "✓" : "✗"} ${o.relay}${o.error ? "  — " + o.error.slice(0, 80) : ""}`);
  }
  const okCount = outcomes.filter((o) => o.ok).length;
  if (okCount === 0) {
    console.log("\n✗ no relay accepted — aborting read-back");
    pool.close();
    process.exit(1);
  }
  console.log(`\n${okCount}/${outcomes.length} relays accepted the event`);

  // Give relays a beat to index. Most are sub-second, some need ~1-2s.
  await new Promise((r) => setTimeout(r, 1500));

  bar(`Read back by #t=${TOPIC_VIDEO}`);
  const t1 = Date.now();
  const events = await pool.querySync(
    [{ kinds: [KIND], "#t": [TOPIC_VIDEO], limit: 10 }],
    5000,
  );
  console.log(`querySync returned ${events.length} event(s) in ${Date.now() - t1} ms`);

  const ours = events.find((e) => e.id === event.id);
  if (ours) {
    console.log(`✓ found our event back: id=${ours.id.slice(0, 12)}…`);
    console.log("  tags:");
    for (const t of ours.tags) console.log("    [" + t.join(", ") + "]");
    console.log(`  sig valid? ${NostrIdentity.verify(ours)}`);
    console.log(`  content: "${ours.content.slice(0, 60)}"`);
  } else {
    console.log("⚠ our event id NOT in the result. Possible reasons:");
    console.log("   · relay accepted but hasn't indexed the #video tag yet");
    console.log("   · relay gates first-time pubkeys (snort/wine sometimes do)");
    console.log("   · replaceable-event indexing differs by relay");
    console.log("   re-running often resolves it. If it persists, the relay set");
    console.log("   used by social/ may need adjustment for cinema discovery.");
    if (events.length > 0) {
      console.log(`   (we did get ${events.length} other events for #video=${VIDEO_ID} — odd unless someone else used the same tag)`);
    }
  }

  bar("Cleanup");
  pool.close();
  console.log("✓ probe complete");
}

main().catch((err) => {
  console.error("\n✗ probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

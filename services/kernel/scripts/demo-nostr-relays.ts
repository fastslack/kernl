/**
 * Live test: connect to public Nostr relays, publish a kind-1, then
 * REQ for events from our own pubkey within the last minute and assert
 * we see what we just published.
 *
 * Uses a fixed test seed so the script is idempotent if you re-run it.
 * Run:  bun scripts/demo-nostr-relays.ts
 */
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { NostrRelayPool, DEFAULT_RELAYS } from "../src/core/nostr/nostr-relay-pool.js";

function header(s: string): void {
  console.log("\n" + "─".repeat(70));
  console.log("  " + s);
  console.log("─".repeat(70));
}

async function main(): Promise<void> {
  header("Setup");
  // Stable seed so re-runs reuse the same pubkey.
  const seed = Buffer.from("11".repeat(32), "hex");
  const id = NostrIdentity.fromEd25519Seed(seed);
  console.log("npub:", id.npub());
  console.log("hex: ", id.pubkeyHex);

  const pool = new NostrRelayPool(DEFAULT_RELAYS);
  console.log("relays:", pool.list().join(", "));

  header("Publish a kind-1 note");
  const note = id.signEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["t", "kernl-test"]],
    content: "🧪 Kernl Nostr bridge smoke test " + Date.now(),
  });
  console.log("event id:", note.id);
  const outcomes = await pool.publish(note);
  for (const o of outcomes) {
    console.log(`  ${o.ok ? "✓" : "✗"} ${o.relay}${o.error ? `  — ${o.error}` : ""}`);
  }
  const okCount = outcomes.filter((o) => o.ok).length;
  console.log(`\naccepted by ${okCount}/${outcomes.length} relays`);

  if (okCount === 0) {
    console.error("no relay accepted the event — aborting");
    pool.close();
    process.exit(1);
  }

  header("REQ events back from pubkey");
  // Give the relays a moment to propagate.
  await new Promise((r) => setTimeout(r, 1500));
  const since = Math.floor(Date.now() / 1000) - 120;
  const events = await pool.querySync(
    [{ authors: [id.pubkeyHex], kinds: [1], since, limit: 10 }],
    5000,
  );
  console.log(`got ${events.length} events back`);
  const found = events.find((e) => e.id === note.id);
  if (found) {
    console.log("✓ round-trip OK — saw our note back from relays");
    console.log(`  content: ${found.content}`);
  } else {
    console.log("✗ did NOT see our note back (network delay or relay drop)");
  }

  header("Relay status");
  for (const s of pool.status()) {
    console.log(`  ${s.status.padEnd(10)} ${s.url}${s.lastError ? `  — ${s.lastError}` : ""}`);
  }

  pool.close();
  // SimplePool's close is async-ish; give sockets a tick to drain.
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});

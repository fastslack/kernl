/**
 * Delete every forum row whose slug doesn't look like a hierarchical
 * path. Built for the one-shot cleanup after Phase-1 ingested NIP-72
 * communities with random d-tags (UUIDs, hex blobs) before the
 * isPathShapedSlug filter was added to the mapper.
 *
 *   bun scripts/cleanup-junk-forums.ts            # dry run
 *   bun scripts/cleanup-junk-forums.ts --apply    # delete
 */

import { Database } from "bun:sqlite";

const DB_PATH = process.env.KERNEL_DB_PATH ?? "/app/data/mtw.db";
const apply = process.argv.includes("--apply");

function isPathShapedSlug(s: string): boolean {
  if (!s || s.length > 96) return false;
  if (!/[a-zA-Z]/.test(s)) return false;
  if (/\s/.test(s)) return false;
  if (!/^[a-zA-Z0-9/_-]+$/.test(s)) return false;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)) return false;
  if (/^[a-f0-9]{16,}$/i.test(s)) return false;
  return true;
}

const db = new Database(DB_PATH);
const rows = db.prepare("SELECT id, slug, name FROM social_forums ORDER BY slug").all() as Array<{ id: string; slug: string; name: string }>;

const junk = rows.filter((r) => !isPathShapedSlug(r.slug));
const keep = rows.filter((r) => isPathShapedSlug(r.slug));

console.log(`Total forums: ${rows.length}`);
console.log(`Path-shaped:  ${keep.length}`);
console.log(`Junk:         ${junk.length}\n`);

if (junk.length > 0) {
  console.log("Junk slugs about to be removed:");
  for (const r of junk) console.log(`  /${r.slug}  — ${r.name || "(no name)"}`);
}

if (!apply) {
  console.log("\nDry run — pass --apply to delete.");
  process.exit(0);
}

const tx = db.transaction(() => {
  const stmt = db.prepare("DELETE FROM social_forums WHERE id = ?");
  // Posts referencing these forums lose their forum scope but stay readable.
  const clearPosts = db.prepare("UPDATE social_posts SET forum_id = NULL WHERE forum_id = ?");
  for (const r of junk) {
    clearPosts.run(r.id);
    stmt.run(r.id);
  }
});
tx();

console.log(`\nDeleted ${junk.length} junk forum rows. Remaining: ${keep.length}.`);

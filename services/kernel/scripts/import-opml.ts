/**
 * Import an OPML feed list into the rss-registry.
 *
 * USAGE:
 *   bun run scripts/import-opml.ts <path/to/feeds.opml> [--clear]
 *
 * Each top-level <outline text="X"> block becomes a category; each nested
 * <outline type="rss"> becomes a feed. Outline elements directly under
 * <body> with type="rss" are imported as Uncategorized. Idempotent: feeds
 * with an existing slug are skipped, categories are reused by name.
 *
 * Note: the kernel does NOT need to be running. We open the SQLite file
 * directly and run rss-registry migrations + imports against it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { rssRegistryMigrations } from "../assets/extensions/integration/rss-registry/_module/migrations.js";
import { RssRegistryService } from "../assets/extensions/integration/rss-registry/_module/service.js";

interface OpmlFeed {
  category: string | null; // null = uncategorized
  name: string;
  feed_url: string;
  website_url: string;
}

// ── Parse ──────────────────────────────────────────────────────────────

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? decode(m[1]) : "";
}

function parseOpml(xml: string): { categories: string[]; feeds: OpmlFeed[] } {
  const feeds: OpmlFeed[] = [];
  const cats = new Set<string>();

  // Walk character-by-character maintaining a stack of currently-open category
  // names. Self-closing <outline ... /> entries with type="rss" become feeds;
  // group <outline text="cat"> ... </outline> push/pop the stack.
  const stack: string[] = [];
  const tagRe = /<outline\b([^>]*?)(\/?)>|<\/outline\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const full = m[0];
    const isClose = full.startsWith("</outline");
    if (isClose) {
      stack.pop();
      continue;
    }
    const attrs = m[1] ?? "";
    const selfClose = m[2] === "/";
    const type = attr(attrs, "type");
    const text = attr(attrs, "text") || attr(attrs, "title");

    if (type === "rss") {
      const xmlUrl = attr(attrs, "xmlUrl");
      const htmlUrl = attr(attrs, "htmlUrl");
      if (xmlUrl) {
        const category = stack.length > 0 ? stack[stack.length - 1] : null;
        feeds.push({
          category,
          name: text || xmlUrl,
          feed_url: xmlUrl,
          website_url: htmlUrl,
        });
      }
      // self-close (no children) — no stack push
    } else if (!selfClose) {
      // Group node — push the category
      stack.push(text);
      cats.add(text);
    }
  }
  return { categories: Array.from(cats), feeds };
}

// ── Category cosmetics ─────────────────────────────────────────────────

const ICON_BY_NAME: Record<string, string> = {
  android: "🤖",
  google: "🔎",
  maemo: "📱",
  security: "🛡️",
  downloads: "📥",
  ciencia: "🔬",
  enlightenment: "✨",
  slackware: "🐧",
  joomla: "🧩",
  blogs: "✍️",
  tecnologia: "💻",
  noticias: "📰",
  firefox: "🦊",
  linux: "🐧",
  computacion: "🖥️",
  gadgets: "🎛️",
  programacion: "⌨️",
  "software-libre": "🆓",
  apple: "🍎",
  ubuntu: "🟠",
  politica: "🏛️",
  design: "🎨",
};

function iconFor(name: string): string {
  const k = name.toLowerCase();
  return ICON_BY_NAME[k] ?? "📁";
}

function prettyCategoryName(raw: string): string {
  // OPML uses lowercase folder names like "linux", "noticias". Capitalize
  // first letter for display while keeping a single canonical form.
  if (!raw) return "Uncategorized";
  return raw[0].toUpperCase() + raw.slice(1);
}

// ── Main ───────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const clearFlag = args.includes("--clear");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("USAGE: bun run scripts/import-opml.ts <feeds.opml> [--clear]");
    process.exit(1);
  }
  const dbPath = process.env.SQLITE_PATH ??
    resolve(process.cwd(), "data/kernel.db");

  console.log(`Reading: ${path}`);
  const xml = readFileSync(path, "utf-8");

  console.log(`Parsing OPML…`);
  const { categories, feeds } = parseOpml(xml);
  console.log(`Found ${categories.length} categories, ${feeds.length} feeds`);

  console.log(`Opening: ${dbPath}`);
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  console.log(`Running migrations…`);
  runMigrations(db, "rss-registry", rssRegistryMigrations);

  const service = new RssRegistryService(db, null);

  if (clearFlag) {
    console.log("--clear: dropping existing items + feeds + categories");
    db.exec("DELETE FROM rss_items; DELETE FROM rss_registry; DELETE FROM rss_categories;");
  }

  // 1) Upsert categories
  const catIdByName = new Map<string, string>();
  for (const raw of categories) {
    const display = prettyCategoryName(raw);
    let cat = service.getCategoryByName(display);
    if (!cat) {
      cat = service.addCategory({ name: display, icon: iconFor(raw) });
      console.log(`  + category: ${display}`);
    }
    catIdByName.set(raw, cat.id);
  }

  // 2) Insert feeds (dedupe by slug; OPML may repeat URLs across folders)
  let added = 0;
  let skipped = 0;
  const slugOf = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

  // Keep a per-process set so duplicate slugs don't collide on the same run.
  const seenSlugs = new Set<string>();

  for (const f of feeds) {
    let slug = slugOf(f.name);
    if (!slug) slug = slugOf(f.feed_url);
    let candidate = slug;
    let n = 2;
    while (seenSlugs.has(candidate) || service.getFeedBySlug(candidate)) {
      candidate = `${slug}-${n++}`;
      if (n > 50) break;
    }
    if (service.getFeedBySlug(candidate)) {
      skipped++;
      continue;
    }
    seenSlugs.add(candidate);

    const lower = f.feed_url.toLowerCase();
    const lang = lower.includes("/es/") || /\b(spanish|espanol|español)\b/i.test(f.name) ? "es" : "en";

    try {
      service.addFeed({
        name: f.name.slice(0, 200),
        slug: candidate,
        feed_url: f.feed_url,
        website_url: f.website_url,
        category_id: f.category ? (catIdByName.get(f.category) ?? null) : null,
        language: lang,
        update_frequency: "daily",
        quality_score: 50,
        tags: f.category ? [f.category] : [],
      });
      added++;
    } catch (err) {
      console.warn(`  ! skip ${f.name}: ${err instanceof Error ? err.message : err}`);
      skipped++;
    }
  }

  console.log(`Done — categories: ${catIdByName.size}, feeds added: ${added}, skipped: ${skipped}`);
  db.close();
}

main();

/**
 * Stage-5 demo — exercises every kernel_cinema_* MCP tool.
 *
 * Builds a real CinemaModule, calls cinemaTools(deps) with lazy refs,
 * invokes each tool with a representative input, and prints the
 * textResult bodies so we can eyeball the agent-facing output shape.
 *
 *   1. ingest a small batch (so /list and /search have data)
 *   2. embed (so semantic search works)
 *   3. exercise list, get, search, watchlist, watched, ingest_status,
 *      subs_list, subs_publish, publisher_trust
 *
 * Run:
 *   npx tsx scripts/demo-cinema-tools.ts
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { runMigrations } from "../src/core/db/migrations.js";
import { Neo4jClient } from "../src/core/db/neo4j.js";
import { loadConfig } from "../src/core/config.js";
import { createEmbeddingsClient } from "../src/core/embeddings/index.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { CinemaSubsService } from "../assets/extensions/leisure/cinema/_module/subs-service.js";
import { DiscoveryRegistry } from "../assets/extensions/leisure/cinema/_module/discovery/registry.js";
import { NostrSubsProvider } from "../assets/extensions/leisure/cinema/_module/discovery/nostr-provider.js";
import { ArchiveSubsProvider } from "../assets/extensions/leisure/cinema/_module/discovery/archive-provider.js";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { ingestPass } from "../assets/extensions/leisure/cinema/_module/ingester.js";
import { embedPending } from "../assets/extensions/leisure/cinema/_module/embeddings.js";
import { cinemaTools } from "../assets/extensions/leisure/cinema/_module/tools.js";
import type { ToolDefinition, ToolResult } from "../src/core/types.js";

function bar(s: string): void {
  console.log("\n" + "─".repeat(72) + "\n  " + s + "\n" + "─".repeat(72));
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

async function call(t: ToolDefinition, args: unknown): Promise<ToolResult> {
  const r = await t.handler(args);
  return r;
}

function printResult(label: string, r: ToolResult): void {
  const isError = r.isError ? " ✗" : "";
  console.log(`\n[${label}]${isError}`);
  for (const block of r.content) {
    if (block.type === "text") {
      const lines = block.text.split("\n");
      const truncated = lines.length > 25 ? lines.slice(0, 25).concat([`  …(+${lines.length - 25} more lines)`]) : lines;
      for (const line of truncated) console.log("  " + line);
    }
  }
}

async function main(): Promise<void> {
  bar("Stage-5 demo · MCP tools end-to-end");

  const config = loadConfig();
  const db = new Database(":memory:");
  runMigrations(db, "cinema", cinemaMigrations);
  const service = new CinemaService(db);
  const subs = new CinemaSubsService(db);

  const neo4j = new Neo4jClient();
  await neo4j.connect(config.neo4j).catch(() => undefined);
  if (neo4j.available) {
    await neo4j.run("MATCH (c:CinemaTitle) DETACH DELETE c");
  }

  const embedder = await createEmbeddingsClient(config);

  const ephemeralId = NostrIdentity.fromEd25519Seed(randomBytes(32));
  const registry = new DiscoveryRegistry();
  registry.register(new NostrSubsProvider(ephemeralId, {
    queryTimeoutMs: 4000,
    relays: ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.snort.social"],
  }));
  registry.register(new ArchiveSubsProvider());

  bar("Seed: ingest one scrape page + embed 32");
  const run = service.startRun("silent_films");
  const r = await ingestPass(service, run, { pageSize: 100, maxPages: 1 });
  service.updateRun(run.id, {
    status: r.finished ? "done" : "running",
    finished_at: r.finished ? new Date().toISOString() : null,
  });
  console.log(`ingested ${r.inserted} titles (${r.fetched} fetched)`);
  if (neo4j.available) {
    let total = 0;
    while (total < 32) {
      const er = await embedPending(service, embedder, neo4j, 32 - total);
      if (er.embedded === 0) break;
      total += er.embedded;
    }
    console.log(`embedded ${total} titles`);
  }

  // Build the tool set the same way the module does.
  const tools = cinemaTools({
    service, subs,
    neo4j: () => neo4j,
    embedder: () => embedder,
    registry: () => registry,
  });
  console.log(`tool count: ${tools.length}`);
  for (const t of tools) console.log(`  · ${t.name}`);

  bar("kernel_cinema_list — top 5 by downloads");
  printResult("list", await call(tool(tools, "kernel_cinema_list"), {
    limit: 5,
    sort: "downloads",
  }));

  bar("kernel_cinema_list — q=chaplin");
  printResult("list-q", await call(tool(tools, "kernel_cinema_list"), {
    query: "chaplin",
    limit: 5,
  }));

  bar("kernel_cinema_get — top result");
  const top = service.list({ limit: 1 })[0];
  if (top) {
    printResult("get", await call(tool(tools, "kernel_cinema_get"), {
      identifier: top.identifier,
    }));
  }

  bar("kernel_cinema_search — semántica español");
  if (neo4j.available) {
    printResult("search", await call(tool(tools, "kernel_cinema_search"), {
      query: "películas dirigidas por Charlie Chaplin",
      limit: 5,
    }));
  } else {
    console.log("  (skipped — neo4j down)");
  }

  bar("kernel_cinema_watchlist — toggle on");
  if (top) {
    printResult("wl-add", await call(tool(tools, "kernel_cinema_watchlist"), {
      identifier: top.identifier,
      watchlist: true,
    }));
  }

  bar("kernel_cinema_list — watchlist=true");
  printResult("list-wl", await call(tool(tools, "kernel_cinema_list"), {
    watchlist: true,
    limit: 5,
  }));

  bar("kernel_cinema_watched — mark seen");
  if (top) {
    printResult("watched", await call(tool(tools, "kernel_cinema_watched"), {
      identifier: top.identifier,
      watched: true,
    }));
  }

  bar("kernel_cinema_subs_list — empty (no published yet)");
  if (top) {
    printResult("subs", await call(tool(tools, "kernel_cinema_subs_list"), {
      identifier: top.identifier,
      refresh: false,
    }));
  }

  bar("kernel_cinema_subs_publish — fake announcement");
  if (top) {
    printResult("subs-publish", await call(tool(tools, "kernel_cinema_subs_publish"), {
      identifier: top.identifier,
      src_lang: "en",
      tgt_lang: "es",
      engine: "nllb-demo",
      engine_version: "v0",
      webseed_url: "https://example.invalid/probe.es.srt",
      sha256: "deadbeef".repeat(8),
      size_bytes: 4096,
      content: `Demo MCP tools — Spanish subs for ${top.identifier}`,
    }));
  }

  bar("kernel_cinema_publisher_trust — mark ephemeral key as trusted");
  printResult("trust", await call(tool(tools, "kernel_cinema_publisher_trust"), {
    pubkey: ephemeralId.pubkeyHex,
    trust: "trusted",
    alias: "demo-bot",
    notes: "stage-5 demo identity",
  }));

  bar("kernel_cinema_subs_list — refresh=true (Nostr round-trip)");
  // small wait so relays can index the publish
  await new Promise((r) => setTimeout(r, 1500));
  if (top) {
    printResult("subs-refresh", await call(tool(tools, "kernel_cinema_subs_list"), {
      identifier: top.identifier,
      refresh: true,
    }));
  }

  bar("kernel_cinema_ingest_status");
  printResult("status", await call(tool(tools, "kernel_cinema_ingest_status"), {}));

  bar("✓ all tools exercised");
  console.log("Each tool returned a textResult / errorResult. Agent-facing");
  console.log("output is human-readable Markdown-friendly for relay to LLMs.");

  if (neo4j.available) await neo4j.close().catch(() => undefined);
  for (const p of registry.list()) {
    const close = (p as { close?: () => Promise<void> }).close;
    if (typeof close === "function") await close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("\n✗ demo failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});

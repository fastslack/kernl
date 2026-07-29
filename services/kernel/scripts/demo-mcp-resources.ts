#!/usr/bin/env bun
/**
 * Demo: MCP `resources/*` providers — workspace analyses + Claude skills.
 *
 *   bun scripts/demo-mcp-resources.ts
 *
 * Boots an in-memory kernel slice (just enough to register a workspace, write
 * a fake analysis file to disk, and instantiate the two ResourceProviders),
 * then drives `list()` + `read()` end-to-end.
 *
 * Why this matters: David Soria Parra's MCP keynote calls out "rich semantics"
 * — tasks, resources, elicitation — as primitives MCP servers should expose
 * but most don't. Until now `kernl` declared only `tools`. With this
 * demo, you can wire MCP Inspector or any resource-aware client to the kernel
 * and see every published office analysis + every installed skill as a
 * first-class read-only resource. No tool slot burned, no LLM round-trip.
 */
import { Database } from "bun:sqlite";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as resolvePath, join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { WorkspaceService } from "../assets/extensions/agents/agent-advanced/_module/workspace-service.js";
import {
  createAnalysisResourceProvider,
  createSkillResourceProvider,
} from "../src/modules/agents/resources.js";

async function main() {
  // ── 1. Stand up a minimal kernel slice ──
  const db = new Database(":memory:");
  runMigrations(db, "agents", agentsMigrations);
  const wsService = new WorkspaceService(db);

  // ── 2. Create a flow + workspace, write a fake analysis file ──
  // The workspace_service writes to data/workspaces/<id>/, but for the demo
  // we redirect WORKSPACE_ROOT by writing into the same path it expects.
  const flowId = "demo-flow";
  const ws = wsService.create({
    owner_flow_id: flowId,
    name: "demo-office",
    description: "Demo workspace for MCP resources",
    shared: true,
  });

  const projectRoot = resolvePath(import.meta.dir, "..");
  const analysesDir = resolvePath(projectRoot, "data", "workspaces", ws.id, "analyses");
  await mkdir(analysesDir, { recursive: true });

  const analysisFile = "2026-05-09-progressive-discovery-audit.md";
  const analysisBody = `---
title: Progressive Discovery audit
author: pd-agent
tags: ["mcp", "audit", "agents"]
---

## Summary

Audited the native agent executor against David Soria Parra's MCP keynote.
Identified six gaps; #1 (tool_search) and #5 (resources) shipped today.

## Result

- 547 kernel tools no longer dumped into context for PD agents.
- Workspace analyses now visible as \`kernel-analysis://\` resources.
`;
  await writeFile(join(analysesDir, analysisFile), analysisBody, "utf-8");

  // ── 3. Build the providers exactly the way the agents module does ──
  const analysisProvider = createAnalysisResourceProvider(wsService);
  const skillProvider = createSkillResourceProvider();

  // ── 4. Drive resources/list end-to-end ──
  console.log("─".repeat(72));
  console.log("kernel-analysis:// — list");
  console.log("─".repeat(72));
  const analyses = await analysisProvider.list();
  for (const r of analyses) {
    console.log(`  ${r.uri}`);
    console.log(`    ${r.name} · ${r.mimeType}`);
    if (r.description) console.log(`    ${r.description}`);
  }
  if (analyses.length === 0) console.log("  (none)");

  console.log();
  console.log("─".repeat(72));
  console.log("kernel-skill:// — list (top 8)");
  console.log("─".repeat(72));
  const skills = await skillProvider.list();
  for (const r of skills.slice(0, 8)) {
    console.log(`  ${r.uri}`);
    console.log(`    ${r.name}`);
    if (r.description) console.log(`    ${r.description.slice(0, 110)}`);
  }
  if (skills.length === 0) console.log("  (no skills found at HOST_HOME/.claude)");
  if (skills.length > 8) console.log(`  …${skills.length - 8} more`);

  // ── 5. resources/read on the analysis we just wrote ──
  console.log();
  console.log("─".repeat(72));
  console.log("kernel-analysis:// — read");
  console.log("─".repeat(72));
  const target = analyses[0]?.uri;
  if (target) {
    const content = await analysisProvider.read(target);
    if (content) {
      console.log(`  uri: ${content.uri}`);
      console.log(`  mimeType: ${content.mimeType}`);
      console.log(`  text (first 240 chars):`);
      console.log(`    ${(content.text ?? "").slice(0, 240).replace(/\n/g, "\n    ")}`);
    } else {
      console.log("  ✗ provider.read returned null — something went wrong");
    }
  }

  // Bad URI → null (proves URI parsing rejects garbage)
  console.log();
  console.log("kernel-analysis:// — bad URI safety check");
  const bad = await analysisProvider.read("kernel-analysis://nope/../etc-passwd");
  console.log(`  read("kernel-analysis://nope/../etc-passwd") → ${bad === null ? "null ✓" : "leaked content ✗"}`);

  // ── 6. Read a real skill if any are present ──
  if (skills.length > 0) {
    console.log();
    console.log("─".repeat(72));
    console.log(`kernel-skill:// — read first one: ${skills[0].uri}`);
    console.log("─".repeat(72));
    const content = await skillProvider.read(skills[0].uri);
    if (content?.text) {
      console.log(`  ${content.text.split("\n").slice(0, 6).join("\n  ")}`);
      console.log(`  …(${content.text.length} chars total)`);
    } else {
      console.log("  ✗ skill not readable (sanitized away or missing)");
    }
  }

  // ── Cleanup ──
  await rm(resolvePath(projectRoot, "data", "workspaces", ws.id), { recursive: true, force: true });

  console.log();
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

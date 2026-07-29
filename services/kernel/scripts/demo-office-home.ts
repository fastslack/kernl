/**
 * Demo: office home repo (migration v36).
 *
 * Exercises the data path end-to-end against an in-memory DB (no LLM):
 *   1. Create an office → it auto-gets a kernel-workspace home.
 *   2. resolveFlowHome → workspace path (what a claude_code agent inherits as cwd).
 *   3. Seed the folder convention on disk into a temp dir.
 *   4. Promote the office to a host git repo → resolveFlowHome flips to that path.
 *   5. Revert → back to the kernel workspace.
 *
 * Usage:  bun run scripts/demo-office-home.ts
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { seedOfficeHome } from "../src/modules/agents/office-home.js";

const db = new Database(":memory:");
db.run("PRAGMA foreign_keys = ON");
runMigrations(db, "agents", agentsMigrations);
const service = new AgentService(db, new EventBus());

console.log("1) create office 'Marketing'");
const flow = service.createFlow({ name: "Marketing", description: "Genera y publica contenido" });
console.log(`   flow id            = ${flow.id}`);
console.log(`   home_workspace_id  = ${flow.home_workspace_id}`);

console.log("\n2) resolveFlowHome (default = kernel workspace)");
let home = service.resolveFlowHome(flow.id)!;
console.log(`   kind = ${home.kind}`);
console.log(`   path = ${home.path}`);

console.log("\n3) seed the folder convention into a temp dir");
const dir = mkdtempSync(join(tmpdir(), "demo-office-"));
seedOfficeHome(dir, flow);
console.log(`   ${dir} ->`, readdirSync(dir).join(", "));
rmSync(dir, { recursive: true, force: true });

console.log("\n4) promote to a host git repo");
const repoPath = join(homedir(), "mtwProjects/LABS/marketing-office");
service.setFlowRepo(flow.id, repoPath);
home = service.resolveFlowHome(flow.id)!;
console.log(`   kind = ${home.kind}`);
console.log(`   path = ${home.path}`);

console.log("\n5) revert to the kernel workspace");
service.setFlowRepo(flow.id, "");
home = service.resolveFlowHome(flow.id)!;
console.log(`   kind = ${home.kind}`);
console.log(`   path = ${home.path}`);

db.close();
console.log("\n✓ demo done");

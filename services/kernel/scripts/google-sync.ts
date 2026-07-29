import { loadConfig } from "../src/core/config.js";
import { openSqlite, closeSqlite } from "../src/core/db/sqlite.js";
import { Neo4jClient } from "../src/core/db/neo4j.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { googleSyncMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/001_google_sync.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { GoogleAuth } from "../assets/extensions/integration/google-sync/_module/auth.js";
import { GoogleClient } from "../assets/extensions/integration/google-sync/_module/google-client.js";
import { CrmService } from "../assets/extensions/people/crm/_module/service.js";
import { ReminderService } from "../assets/extensions/productivity/reminders/_module/service.js";
import { TaskService } from "../assets/extensions/productivity/tasks/_module/service.js";
import { importContacts } from "../assets/extensions/integration/google-sync/_module/importers/contacts.js";
import { importOtherContacts } from "../assets/extensions/integration/google-sync/_module/importers/other-contacts.js";
import { importCalendar } from "../assets/extensions/integration/google-sync/_module/importers/calendar.js";
import { importTasks } from "../assets/extensions/integration/google-sync/_module/importers/tasks.js";
import { importGmail } from "../assets/extensions/integration/google-sync/_module/importers/gmail.js";
import type { ImportResult } from "../assets/extensions/integration/google-sync/_module/types.js";

async function main() {
  const config = loadConfig();
  const db = openSqlite(config.sqlite.path);
  const neo4j = new Neo4jClient();
  await neo4j.connect(config.neo4j);

  const auth = new GoogleAuth(db, config.google.clientId, config.google.clientSecret, config.google.callbackPort);

  if (!auth.isAuthenticated()) {
    console.error("No autenticado. Ejecuta primero: npx tsx scripts/google-auth.ts");
    process.exit(1);
  }

  const client = new GoogleClient(auth);
  const crmService = new CrmService(db, neo4j);
  const reminderService = new ReminderService(db, neo4j);
  const taskService = new TaskService(db, neo4j);

  console.log("Iniciando sincronización completa...\n");

  const results: ImportResult[] = [];

  console.log("1/5 — Contacts...");
  results.push(await importContacts(client, db, crmService));

  console.log("2/5 — Other Contacts...");
  results.push(await importOtherContacts(client, db, crmService));

  console.log("3/5 — Calendar...");
  results.push(await importCalendar(client, db, reminderService));

  console.log("4/5 — Tasks...");
  results.push(await importTasks(client, db, taskService));

  console.log("5/5 — Gmail interactions...");
  results.push(await importGmail(client, db, crmService));

  console.log("\n════════════════════════════════════════════════════");
  console.log("  SYNC COMPLETA");
  console.log("════════════════════════════════════════════════════\n");

  let total = 0;
  for (const r of results) {
    total += r.imported;
    let line = `  ${r.source}: ${r.imported} imported, ${r.skipped} skipped`;
    if (r.errors.length > 0) line += ` (${r.errors.length} errors)`;
    console.log(line);
  }
  console.log(`\n  Total: ${total} items importados`);

  if (results.some((r) => r.errors.length > 0)) {
    console.log("\nErrores:");
    for (const r of results) {
      for (const e of r.errors) console.log(`  [${r.source}] ${e}`);
    }
  }

  await neo4j.close();
  closeSqlite(db);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

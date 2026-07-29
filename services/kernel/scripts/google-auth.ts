import { loadConfig } from "../src/core/config.js";
import { openSqlite, closeSqlite } from "../src/core/db/sqlite.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { googleSyncMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/001_google_sync.js";
import { GoogleAuth } from "../assets/extensions/integration/google-sync/_module/auth.js";

async function main() {
  const config = loadConfig();
  const db = openSqlite(config.sqlite.path);
  runMigrations(db, "google-sync", googleSyncMigrations);

  const auth = new GoogleAuth(
    db,
    config.google.clientId,
    config.google.clientSecret,
    config.google.callbackPort,
  );

  if (auth.isAuthenticated()) {
    console.log("Ya estás autenticado con Google!");
    closeSqlite(db);
    process.exit(0);
  }

  console.log("Iniciando servidor de callback...\n");
  const url = await auth.startCallbackServer();
  console.log("════════════════════════════════════════════════════");
  console.log("  ABRE ESTA URL EN TU BROWSER:");
  console.log(`  ${url}`);
  console.log("════════════════════════════════════════════════════");
  console.log("\nEsperando autorización en http://localhost:8787/callback ...");

  // Keep alive for 5 minutes
  await new Promise((resolve) => setTimeout(resolve, 300_000));
  closeSqlite(db);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

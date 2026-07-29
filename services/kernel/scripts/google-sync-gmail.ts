import { loadConfig } from "../src/core/config.js";
import { openSqlite, closeSqlite } from "../src/core/db/sqlite.js";
import { Neo4jClient } from "../src/core/db/neo4j.js";
import { GoogleAuth } from "../assets/extensions/integration/google-sync/_module/auth.js";
import { GoogleClient } from "../assets/extensions/integration/google-sync/_module/google-client.js";
import { CrmService } from "../assets/extensions/people/crm/_module/service.js";
import { importGmail } from "../assets/extensions/integration/google-sync/_module/importers/gmail.js";

async function main() {
  const config = loadConfig();
  const db = openSqlite(config.sqlite.path);
  const neo4j = new Neo4jClient();
  await neo4j.connect(config.neo4j);

  const auth = new GoogleAuth(db, config.google.clientId, config.google.clientSecret, config.google.callbackPort);
  const client = new GoogleClient(auth);
  const crmService = new CrmService(db, neo4j);

  console.log("Sincronizando Gmail...\n");
  const result = await importGmail(client, db, crmService);

  console.log(`\nResultado: ${result.imported} interacciones importadas, ${result.skipped} skipped`);
  if (result.errors.length > 0) {
    console.log(`Errores: ${result.errors.length}`);
    for (const e of result.errors.slice(0, 5)) console.log(`  ${e}`);
    if (result.errors.length > 5) console.log(`  ... y ${result.errors.length - 5} más`);
  }

  await neo4j.close();
  closeSqlite(db);
}

main().catch((err) => { console.error("Error:", err); process.exit(1); });

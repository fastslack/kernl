import { loadConfig } from "../src/core/config.js";
import { openSqlite, closeSqlite } from "../src/core/db/sqlite.js";

const db = openSqlite(loadConfig().sqlite.path);
const deleted = db.prepare("DELETE FROM google_sync_map WHERE source = 'gmail'").run();
db.prepare("DELETE FROM google_sync_meta WHERE source = 'gmail'").run();
console.log(`Deleted ${deleted.changes} gmail sync_map entries`);
closeSqlite(db);

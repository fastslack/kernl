import Database from "better-sqlite3";
const db = new Database("./data/kernel.db");

console.log("\n═══════════════════════════════════════════════════");
console.log("  Kernl — Contact Analytics");
console.log("═══════════════════════════════════════════════════\n");

// Totals
const total = (db.prepare("SELECT COUNT(*) as c FROM contacts").get() as any).c;
const withEmail = (db.prepare("SELECT COUNT(*) as c FROM contacts WHERE email != ''").get() as any).c;
const withPhone = (db.prepare("SELECT COUNT(*) as c FROM contacts WHERE phone != ''").get() as any).c;
const withCompany = (db.prepare("SELECT COUNT(*) as c FROM contacts WHERE company != ''").get() as any).c;
const withNotes = (db.prepare("SELECT COUNT(*) as c FROM contacts WHERE notes != '' AND notes NOT LIKE 'Imported from Google%'").get() as any).c;
const withInteraction = (db.prepare("SELECT COUNT(*) as c FROM contacts WHERE last_interaction IS NOT NULL").get() as any).c;

console.log(`RESUMEN GENERAL`);
console.log(`  Total contactos:      ${total}`);
console.log(`  Con email:            ${withEmail} (${Math.round(withEmail/total*100)}%)`);
console.log(`  Con teléfono:         ${withPhone} (${Math.round(withPhone/total*100)}%)`);
console.log(`  Con empresa:          ${withCompany} (${Math.round(withCompany/total*100)}%)`);
console.log(`  Con notas:            ${withNotes}`);
console.log(`  Con interacción:      ${withInteraction}`);

// Top companies
console.log(`\nTOP 15 EMPRESAS (por # de contactos)`);
const topCompanies = db.prepare(
  "SELECT company, COUNT(*) as c FROM contacts WHERE company != '' GROUP BY company ORDER BY c DESC LIMIT 15"
).all() as any[];
for (const row of topCompanies) {
  console.log(`  ${row.c.toString().padStart(4)} — ${row.company}`);
}

// Domain analysis
console.log(`\nTOP 20 DOMINIOS DE EMAIL`);
const domains = db.prepare(
  `SELECT SUBSTR(email, INSTR(email, '@') + 1) as domain, COUNT(*) as c
   FROM contacts WHERE email != '' AND email LIKE '%@%'
   GROUP BY domain ORDER BY c DESC LIMIT 20`
).all() as any[];
for (const row of domains) {
  console.log(`  ${row.c.toString().padStart(4)} — ${row.domain}`);
}

// Interactions
const totalInteractions = (db.prepare("SELECT COUNT(*) as c FROM interactions").get() as any).c;
console.log(`\nINTERACCIONES`);
console.log(`  Total:                ${totalInteractions}`);

const interByType = db.prepare(
  "SELECT type, COUNT(*) as c FROM interactions GROUP BY type ORDER BY c DESC"
).all() as any[];
for (const row of interByType) {
  console.log(`  ${row.type.padEnd(10)} ${row.c}`);
}

// Most contacted people
console.log(`\nTOP 10 CONTACTOS MÁS ACTIVOS (por interacciones)`);
const mostContacted = db.prepare(
  `SELECT c.name, c.company, c.email, COUNT(i.id) as interactions, MAX(i.date) as last_date
   FROM contacts c
   JOIN interactions i ON i.contact_id = c.id
   GROUP BY c.id
   ORDER BY interactions DESC
   LIMIT 10`
).all() as any[];
for (const row of mostContacted) {
  const company = row.company ? ` @ ${row.company}` : "";
  console.log(`  ${row.interactions.toString().padStart(3)}x — ${row.name}${company} (last: ${row.last_date})`);
}

// Contacts without email (potential data quality issue)
const noEmail = total - withEmail;
const fromOther = (db.prepare("SELECT COUNT(*) as c FROM google_sync_map WHERE source = 'other_contacts'").get() as any).c;
const fromContacts = (db.prepare("SELECT COUNT(*) as c FROM google_sync_map WHERE source = 'contacts'").get() as any).c;

console.log(`\nFUENTES DE IMPORTACIÓN`);
console.log(`  Google Contacts:      ${fromContacts}`);
console.log(`  Google Other:         ${fromOther}`);
console.log(`  Sin email:            ${noEmail} (${Math.round(noEmail/total*100)}%)`);

// Tasks and reminders
const taskCount = (db.prepare("SELECT COUNT(*) as c FROM tasks").get() as any).c;
const reminderCount = (db.prepare("SELECT COUNT(*) as c FROM reminders").get() as any).c;

console.log(`\nOTROS MÓDULOS`);
console.log(`  Tareas:               ${taskCount}`);
console.log(`  Reminders:            ${reminderCount}`);

// Stale contacts (have email but no interaction)
const stale = (db.prepare(
  "SELECT COUNT(*) as c FROM contacts WHERE email != '' AND last_interaction IS NULL"
).get() as any).c;
console.log(`\n⚠ CONTACTOS CON EMAIL PERO SIN INTERACCIÓN: ${stale}`);

console.log("\n═══════════════════════════════════════════════════\n");

db.close();

/**
 * Data migration script: Create a default email account from existing Google tokens.
 *
 * Run: npx tsx scripts/migrate-email-accounts.ts
 *
 * What it does:
 * 1. Checks if google_tokens has a row (existing Gmail auth)
 * 2. Creates a default email_account for that Gmail
 * 3. Links existing communications to the new account
 */

import { loadConfig } from "../src/core/config.js";
import { openSqlite, closeSqlite } from "../src/core/db/sqlite.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { commsMigrations } from "../assets/extensions/people/comms/_module/migrations.js";
import { newId, isoNow } from "../src/core/helpers.js";

const config = loadConfig();
const db = openSqlite(config.sqlite.path);

// Ensure latest migrations
runMigrations(db, "comms", commsMigrations);

// Check for existing email accounts
const existingAccounts = db.prepare("SELECT COUNT(*) AS c FROM email_accounts").get() as { c: number };
if (existingAccounts.c > 0) {
  console.log(`Already have ${existingAccounts.c} email account(s). Skipping migration.`);
  closeSqlite(db);
  process.exit(0);
}

// Check for existing Google tokens
let hasGoogleAuth = false;
try {
  const tokens = db.prepare("SELECT * FROM google_tokens WHERE id = 1").get();
  hasGoogleAuth = !!tokens;
} catch {
  console.log("No google_tokens table found. Skipping Google account creation.");
}

if (!hasGoogleAuth) {
  console.log("No Google OAuth tokens found. No default account to create.");
  console.log("Use kernel_comms_add_account to add email accounts manually.");
  closeSqlite(db);
  process.exit(0);
}

// Try to find the Gmail address from existing sent communications
let gmailAddress = "";
const sentComm = db.prepare(
  "SELECT recipients_to FROM communications WHERE direction = 'outbound' AND status = 'sent' LIMIT 1",
).get() as { recipients_to: string } | undefined;

if (!sentComm) {
  // Try to get from inbound emails metadata
  const inboundComm = db.prepare(
    "SELECT recipients_to FROM communications WHERE direction = 'inbound' LIMIT 1",
  ).get() as { recipients_to: string } | undefined;
  if (inboundComm) {
    gmailAddress = inboundComm.recipients_to.split(",")[0].trim();
  }
}

if (!gmailAddress) {
  gmailAddress = "gmail-user@gmail.com"; // placeholder
  console.log("Could not detect Gmail address. Using placeholder — update with kernel_comms_update_account.");
}

const now = isoNow();
const accountId = newId();

db.prepare(
  `INSERT INTO email_accounts (id, label, email, type, provider, company, signature, provider_config, is_default, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(accountId, "Gmail", gmailAddress, "personal", "gmail", "", "", "{}", 1, now, now);

// Link existing communications to this account
const linkedCount = db.prepare("UPDATE communications SET account_id = ? WHERE account_id IS NULL").run(accountId);

console.log(`Created default Gmail account: ${accountId}`);
console.log(`  Email: ${gmailAddress}`);
console.log(`  Linked ${linkedCount.changes} existing communication(s)`);

closeSqlite(db);

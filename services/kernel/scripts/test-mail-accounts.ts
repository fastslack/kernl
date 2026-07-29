/**
 * One-shot: read every imap_smtp account from the DB, try IMAP LOGIN + SMTP
 * EHLO against it, and print a compact verdict per account. Does not mutate
 * anything. Run with:  npx tsx scripts/test-mail-accounts.ts
 */

import Database from "better-sqlite3";
import { ImapSmtpProvider, type ImapSmtpConfig } from "../assets/extensions/people/comms/_module/providers/imap-smtp-provider.js";

const DB_PATH = process.env.KERNEL_DB_PATH ?? "./data/kernel.db";

interface Row { id: string; label: string; email: string; provider_config: string; }

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(
    "SELECT id, label, email, provider_config FROM email_accounts WHERE provider = 'imap_smtp'",
  ).all() as Row[];
  db.close();

  if (rows.length === 0) {
    console.log("No imap_smtp accounts found.");
    process.exit(0);
  }

  console.log(`Testing ${rows.length} IMAP/SMTP account(s)…\n`);
  for (const r of rows) {
    let cfg: ImapSmtpConfig;
    try { cfg = JSON.parse(r.provider_config); }
    catch { console.log(`  ${r.email}  ✗  invalid provider_config JSON`); continue; }

    const provider = new ImapSmtpProvider(cfg, r.email);
    const t0 = Date.now();
    const res = await provider.verify();
    const ms = Date.now() - t0;
    const imap = res.imap ? "✓" : "✗";
    const smtp = res.smtp ? "✓" : "✗";
    const line = `  ${r.email.padEnd(28)}  imap ${imap}  smtp ${smtp}  (${ms} ms)`;
    console.log(res.error ? `${line}\n      ${res.error}` : line);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

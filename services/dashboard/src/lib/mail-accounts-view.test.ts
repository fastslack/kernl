/**
 * The accounts list has to say, at a glance, which mailboxes actually work.
 * The account rows all report status "ok"; whether a mailbox syncs lives in
 * the sync status, and five IMAP boxes on the live kernel were failing with
 * nothing on screen saying so. These cases pin how the list reads.
 */

import { describe, it, expect } from "bun:test";
import { buildAccountView, filterGroups, displayName, type SyncEntry } from "./mail-accounts-view.js";

const acc = (id: string, email: string, over: Record<string, unknown> = {}) => ({
  id, email, label: `VPS ${email}`, type: "work", provider: "imap_smtp", company: "", is_default: 0,
  provider_config: JSON.stringify({ imap_host: "mail.x.com", imap_port: 993, imap_secure: true, smtp_host: "mail.x.com", smtp_port: 465, smtp_secure: true, user: email }),
  ...over,
}) as never;
const sync = (id: string, stored: number, fetch: SyncEntry["fetch"]): SyncEntry => ({ account_id: id, stored, fetch });

const accounts = [
  acc("g", "me@gmail.com", { label: "Gmail", provider: "gmail", type: "personal", is_default: 1, provider_config: "{}" }),
  acc("a", "admin@matware.nl"),
  acc("b", "fastslack@matware.nl"),
  acc("c", "contacto@telenode.online"),
];
const syncs = [
  sync("g", 2492, null),
  sync("a", 20, { state: "error", error: "Failed to establish connection in required time", finished_at: "2026-10-02T19:19:18Z" }),
  sync("b", 20, { state: "ok", finished_at: "2026-10-02T19:24:03Z" }),
  sync("c", 0, { state: "running", started_at: "2026-10-02T19:24:00Z" }),
];
const unread = { g: 2290, a: 0, b: 3, c: 0 };

describe("buildAccountView", () => {
  const view = buildAccountView(accounts, syncs, unread);

  it("groups by domain, the default account's group first, then alphabetical", () => {
    expect(view.groups.map((g) => g.domain)).toEqual(["gmail.com", "matware.nl", "telenode.online"]);
  });

  it("puts failing mailboxes first inside their group", () => {
    expect(view.groups[1].rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("reads the real health from the sync status, not the account status", () => {
    const byId = Object.fromEntries(view.groups.flatMap((g) => g.rows).map((r) => [r.id, r]));
    expect(byId.a.health).toMatchObject({ state: "error", text: "Can't connect" });
    expect(byId.a.health.detail).toContain("Failed to establish connection");
    expect(byId.b.health.state).toBe("ok");
    expect(byId.c.health).toMatchObject({ state: "syncing", text: "Syncing…" });
    expect(byId.g.health).toMatchObject({ state: "ok", text: "Up to date" });
  });

  it("carries the numbers worth seeing: stored and unread", () => {
    const g = view.groups[0].rows[0];
    expect([g.stored, g.unread, g.isDefault]).toEqual([2492, 2290, true]);
  });

  it("summarises the whole list", () => {
    expect(view.summary).toEqual({ total: 4, healthy: 2, failing: 1, syncing: 1, stored: 2532, unread: 2293 });
  });

  it("shows the IMAP/SMTP servers for the expanded row", () => {
    const a = view.groups[1].rows[0];
    expect(a.servers).toEqual({ imap: "mail.x.com:993 · TLS", smtp: "mail.x.com:465 · TLS", user: "admin@matware.nl" });
  });

  it("a mailbox never synced says so instead of pretending to be fine", () => {
    const v = buildAccountView([acc("z", "new@x.com")], [sync("z", 0, null)], {});
    expect(v.groups[0].rows[0].health).toMatchObject({ state: "never", text: "Not synced yet" });
  });
});

describe("displayName", () => {
  it("drops the 'VPS <email>' boilerplate and keeps the mailbox name", () => {
    expect(displayName("VPS admin@matware.nl", "admin@matware.nl")).toBe("admin");
    expect(displayName("Gmail", "me@gmail.com")).toBe("Gmail");
    expect(displayName("Ventas Matware", "ventas@matware.nl")).toBe("Ventas Matware");
  });
});

describe("filterGroups", () => {
  const view = buildAccountView(accounts, syncs, unread);

  it("'problems' keeps only failing mailboxes and drops empty groups", () => {
    const g = filterGroups(view.groups, "problems", "");
    expect(g.map((x) => x.domain)).toEqual(["matware.nl"]);
    expect(g[0].rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("filters by type and by free text over name, email and domain", () => {
    expect(filterGroups(view.groups, "personal", "").flatMap((g) => g.rows).map((r) => r.id)).toEqual(["g"]);
    expect(filterGroups(view.groups, "all", "telenode").flatMap((g) => g.rows).map((r) => r.id)).toEqual(["c"]);
    expect(filterGroups(view.groups, "all", "FASTSLACK@").flatMap((g) => g.rows).map((r) => r.id)).toEqual(["b"]);
  });
});

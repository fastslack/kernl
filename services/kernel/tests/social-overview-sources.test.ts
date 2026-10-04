/**
 * The two data sources the Social overview adds: contacts gone quiet (crm)
 * and the IRC activity summary (irc).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { CrmService } from "../assets/extensions/people/crm/_module/service.js";
import { ircMigrations } from "../assets/extensions/channels/irc/_module/migrations/001_irc.js";
import { ircOverview } from "../assets/extensions/channels/irc/_module/overview-route.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe("CrmService.followUps", () => {
  let db: Database;
  let service: CrmService;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "crm", crmMigrations);
    service = new CrmService(db, () => null);
  });
  afterEach(() => db.close());

  it("counts only contacts you talked to and who went quiet, most-talked-to first", () => {
    const quiet = service.addContact({ name: "Quiet Friend" });
    const chatty = service.addContact({ name: "Old Colleague" });
    const recent = service.addContact({ name: "Recent" });
    service.addContact({ name: "never-talked@example.com" });
    service.logInteraction({ contact_id: quiet.id, type: "call", summary: "", date: daysAgo(60) });
    for (const d of [90, 70, 45]) service.logInteraction({ contact_id: chatty.id, type: "email", summary: "", date: daysAgo(d) });
    service.logInteraction({ contact_id: recent.id, type: "call", summary: "", date: daysAgo(3) });

    const r = service.followUps(30, 5);
    expect(r.count).toBe(2);
    expect(r.items.map((i) => i.name)).toEqual(["Old Colleague", "Quiet Friend"]);
    expect(r.items[0].interactions).toBe(3);
    expect(r.items[0].last_interaction).toBe(daysAgo(45));
  });

  it("is empty when nobody went quiet", () => {
    expect(service.followUps()).toEqual({ count: 0, items: [] });
  });
});

describe("ircOverview", () => {
  let db: Database;
  const now = new Date("2026-10-04T15:00:00");

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "irc", ircMigrations);
    db.run("INSERT INTO irc_channels (name, created_at) VALUES ('#ops', ?), ('#dev', ?)", [now.toISOString(), now.toISOString()]);
  });
  afterEach(() => db.close());

  const msg = (id: string, target: string, sender: string, kind: string, ts: Date, payload: string, encrypted = 0) =>
    db.run(
      "INSERT INTO irc_messages (id, msgid, target, sender, ts, kind, payload, encrypted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, id, target, sender, ts.toISOString(), kind, payload, encrypted],
    );

  it("leaves the kernel's own notices out of activity and recent lines", () => {
    const morning = new Date("2026-10-04T09:00:00");
    const yesterday = new Date("2026-10-03T22:00:00");
    msg("1", "#ops", "kernel", "NOTICE", morning, "Evening Summary — Daily summary");
    msg("2", "#ops", "ana", "PRIVMSG", morning, "deploy done\nsecond line");
    msg("3", "#dev", "bob", "PRIVMSG", yesterday, "hola");
    msg("4", "#dev", "eve", "PRIVMSG", morning, "zzz", 1);
    msg("5", "ana", "bob", "PRIVMSG", morning, "private, not a channel");

    const o = ircOverview(db, null, now);
    expect(o.channels).toBe(2);
    expect(o.today).toBe(3); // 2, 4 and the private 5 — not the kernel notice, not yesterday
    expect(o.recent.map((r) => r.text)).toEqual(["deploy done", "(encrypted)", "hola"]);
    expect(o.lastActivity).toBe(morning.toISOString());
    expect(o.networks).toEqual([]);
  });

  it("reports the networks' live state", () => {
    const o = ircOverview(db, {
      status: () => [{ label: "Libera.Chat", network: "libera", state: "connected", enabled: true, lastError: "" }] as never,
    }, now);
    expect(o.networks).toEqual([{ label: "Libera.Chat", network: "libera", state: "connected", enabled: true, lastError: "" }]);
    expect(o.lastActivity).toBeNull();
  });
});

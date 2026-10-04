import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { CrmService } from "../assets/extensions/people/crm/_module/service.js";
import { unsubscribeToken, verifyUnsubscribeToken, applyUnsubscribe } from "../assets/extensions/people/comms/_module/unsubscribe.js";
import { isDoNotContact, phoneKey } from "../assets/extensions/people/comms/_module/dnc.js";

describe("do not contact", () => {
  it("marks a contact and every lookup honours it", () => {
    const db = new Database(":memory:");
    runMigrations(db, "crm", crmMigrations);
    const crm = new CrmService(db as never, () => null);
    const c = crm.addContact({ name: "Ana", email: "Ana@x.ar", phone: "+54 9 11 5555-0000" });
    expect(isDoNotContact(db as never, { contactId: c.id })).toBe(false);
    crm.setDoNotContact(c.id, true);
    expect(isDoNotContact(db as never, { contactId: c.id })).toBe(true);
    expect(isDoNotContact(db as never, { email: "ana@x.ar" })).toBe(true);
    expect(isDoNotContact(db as never, { phone: "5491155550000" })).toBe(true);
    expect(isDoNotContact(db as never, { phone: "+54 11 4444 0000" })).toBe(false);
    expect(crm.updateContact(c.id, { project_id: "P1" } as never)).toBe(true);
    expect((crm.getById(c.id) as { project_id: string }).project_id).toBe("P1");
  });

  it("phone keys match across the usual Argentine formats", () => {
    expect(phoneKey("+54 9 11 5555-0000")).toBe(phoneKey("5491155550000"));
    expect(phoneKey("+54 9 11 5555-0000").endsWith(phoneKey("011 5555-0000").slice(-10))).toBe(true);
  });

  it("unsubscribe tokens are signed per contact", () => {
    const t = unsubscribeToken("C1", "s3cret");
    expect(verifyUnsubscribeToken(t, "s3cret")).toBe("C1");
    expect(verifyUnsubscribeToken(t, "other")).toBeNull();
    expect(verifyUnsubscribeToken(t.slice(0, -1) + (t.endsWith("a") ? "b" : "a"), "s3cret")).toBeNull();
  });

  it("the unsubscribe link marks the contact; a forged one does nothing", () => {
    const db = new Database(":memory:");
    runMigrations(db, "crm", crmMigrations);
    const crm = new CrmService(db as never, () => null);
    const c = crm.addContact({ name: "Ana", email: "ana@x.ar" });
    expect(applyUnsubscribe(db as never, "garbage", "k")).toBe(false);
    expect(applyUnsubscribe(db as never, unsubscribeToken(c.id, "k"), "k")).toBe(true);
    expect(isDoNotContact(db as never, { contactId: c.id })).toBe(true);
  });

  it("addContact stores the project", () => {
    const db = new Database(":memory:");
    runMigrations(db, "crm", crmMigrations);
    const crm = new CrmService(db as never, () => null);
    const c = crm.addContact({ name: "Leo", email: "leo@x.ar", project_id: "P7" } as never);
    expect((crm.getById(c.id) as { project_id: string; do_not_contact: number })).toMatchObject({ project_id: "P7", do_not_contact: 0 });
  });
});

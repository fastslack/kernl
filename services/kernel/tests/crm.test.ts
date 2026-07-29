import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { CrmService } from "../assets/extensions/people/crm/_module/service.js";

describe("CrmService", () => {
  let db: Database;
  let service: CrmService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "crm", crmMigrations);
    // No graph driver in tests — service falls through capability gates and
    // exercises the SQLite-only path.
    service = new CrmService(db, () => null);
  });

  afterEach(() => {
    db.close();
  });

  it("adds a contact with defaults", () => {
    const contact = service.addContact({ name: "Alice" });
    expect(contact.name).toBe("Alice");
    expect(contact.relationship).toBe("acquaintance");
    expect(contact.id).toBeTruthy();
  });

  it("adds a contact with all fields", () => {
    const contact = service.addContact({
      name: "Bob",
      email: "bob@example.com",
      phone: "+1234567890",
      company: "Acme Corp",
      relationship: "professional",
      notes: "Met at conference",
    });
    expect(contact.email).toBe("bob@example.com");
    expect(contact.company).toBe("Acme Corp");
  });

  it("finds contacts by name", () => {
    service.addContact({ name: "Alice Smith" });
    service.addContact({ name: "Bob Jones" });

    const results = service.find("Alice");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Alice Smith");
  });

  it("finds contacts by company", () => {
    service.addContact({ name: "Alice", company: "Acme" });
    service.addContact({ name: "Bob", company: "Globex" });

    const results = service.find("Acme");
    expect(results).toHaveLength(1);
  });

  it("lists all contacts", () => {
    service.addContact({ name: "A" });
    service.addContact({ name: "B" });
    expect(service.listContacts()).toHaveLength(2);
  });

  it("filters contacts by relationship", () => {
    service.addContact({ name: "A", relationship: "family" });
    service.addContact({ name: "B", relationship: "professional" });

    const family = service.listContacts({ relationship: "family" });
    expect(family).toHaveLength(1);
    expect(family[0].name).toBe("A");
  });

  it("logs an interaction and updates last_interaction", () => {
    const contact = service.addContact({ name: "Alice" });
    const interaction = service.logInteraction({
      contact_id: contact.id,
      type: "call",
      summary: "Discussed project",
    });

    expect(interaction?.type).toBe("call");
    expect(interaction?.summary).toBe("Discussed project");

    // Verify last_interaction updated
    const updated = service.getById(contact.id);
    expect(updated?.last_interaction).toBeTruthy();
  });

  it("returns null for interaction with nonexistent contact", () => {
    const result = service.logInteraction({
      contact_id: "nonexistent",
      type: "call",
      summary: "test",
    });
    expect(result).toBeNull();
  });

  it("gets interactions for a contact", () => {
    const contact = service.addContact({ name: "Alice" });
    service.logInteraction({
      contact_id: contact.id,
      type: "email",
      summary: "Sent proposal",
    });
    service.logInteraction({
      contact_id: contact.id,
      type: "call",
      summary: "Follow-up call",
    });

    const interactions = service.getInteractions(contact.id);
    expect(interactions).toHaveLength(2);
  });
});

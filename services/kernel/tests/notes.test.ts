import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { notesMigrations } from "../assets/extensions/productivity/notes/_module/migrations/001_notes.js";
import { NotesService } from "../assets/extensions/productivity/notes/_module/service.js";
// graph driver mocked as null in tests

describe("NotesService", () => {
  let db: Database;
  let service: NotesService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "notes", notesMigrations);
    service = new NotesService(db, () => null);
  });
  afterEach(() => db.close());

  it("creates a note", () => {
    const note = service.create({ title: "Test note", body: "Hello world" });
    expect(note.id).toBeTruthy();
    expect(note.title).toBe("Test note");
    expect(note.pinned).toBe(0);
  });

  it("creates a pinned note with tags", () => {
    const note = service.create({ title: "Important", tags: "work,urgent", pinned: true });
    expect(note.pinned).toBe(1);
    expect(note.tags).toBe("work,urgent");
  });

  it("updates a note and FTS index", () => {
    const note = service.create({ title: "Original" });
    service.update(note.id, { title: "Updated", body: "New content" });
    const updated = service.getById(note.id);
    expect(updated?.title).toBe("Updated");
    // FTS should find the new content
    const results = service.search("New content");
    expect(results).toHaveLength(1);
  });

  it("deletes a note", () => {
    const note = service.create({ title: "To delete" });
    expect(service.delete(note.id)).toBe(true);
    expect(service.getById(note.id)).toBeFalsy();
  });

  it("searches by FTS", () => {
    service.create({ title: "TypeScript guide", body: "Learn TypeScript from scratch" });
    service.create({ title: "Python tutorial", body: "Learn Python basics" });
    const results = service.search("TypeScript");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("TypeScript guide");
  });

  it("lists with tag filter", () => {
    service.create({ title: "Work note", tags: "work,meeting" });
    service.create({ title: "Personal note", tags: "personal" });
    const work = service.list({ tag: "work" });
    expect(work).toHaveLength(1);
    expect(work[0].title).toBe("Work note");
  });

  it("lists pinned first", () => {
    service.create({ title: "Regular" });
    service.create({ title: "Pinned", pinned: true });
    const all = service.list();
    expect(all[0].title).toBe("Pinned");
  });
});

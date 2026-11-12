import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import type { GraphDriver } from "../src/core/db-drivers/graph-driver.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { notesMigrations } from "../assets/extensions/productivity/notes/_module/migrations/001_notes.js";
import { brainMigrations } from "../src/modules/brain/migrations.js";
import { CrmService } from "../assets/extensions/people/crm/_module/service.js";
import { PeopleService, normIdentity, normName } from "../assets/extensions/people/crm/_module/people.js";
import { FactStore } from "../src/modules/brain/facts.js";

function setup(graph: () => GraphDriver | null = () => null) {
  const db = new Database(":memory:");
  runMigrations(db as never, "crm", crmMigrations);
  return { db, crm: new CrmService(db as never, graph), people: new PeopleService(db as never, graph) };
}

describe("identities", () => {
  it("normalises each kind", () => {
    expect(normIdentity("email", " Ada@Example.COM ")).toBe("ada@example.com");
    expect(normIdentity("email", "not an email")).toBe("");
    expect(normIdentity("phone", "+54 9 11 1234-5678")).toBe("+541112345678");
    expect(normIdentity("phone", "123")).toBe("");
    expect(normIdentity("linkedin", "https://www.linkedin.com/in/Ada-Lovelace/?trk=x")).toBe("in/ada-lovelace");
    expect(normIdentity("x", "https://x.com/ada_l")).toBe("ada_l");
    expect(normIdentity("instagram", "@Ada.L")).toBe("ada.l");
    expect(normIdentity("website", "http://www.Analytical.org/about")).toBe("analytical.org");
    expect(normName("  José   Pérez ")).toBe("jose perez");
  });

  it("keeps a second address on dedup and recognises the person by it", () => {
    const { crm, people } = setup();
    const ada = crm.addContact({ name: "Ada Lovelace", email: "ada@home.org", phone: "+44 20 7946 0000" });
    const again = crm.addContact({ name: "Ada L.", email: "ada@work.com", phone: "+442079460000" });
    expect(again.id).toBe(ada.id);
    expect(people.identities(ada.id).map((i) => `${i.kind}:${i.value_norm}`).sort()).toEqual([
      "email:ada@home.org", "email:ada@work.com", "phone:+442079460000",
    ]);
    // Arriving by the second address only still finds her.
    expect(crm.addContact({ name: "A. Lovelace", email: "ADA@work.com" }).id).toBe(ada.id);
    expect(crm.findExisting(undefined, "ada@work.com")?.id).toBe(ada.id);
  });
});

describe("duplicates", () => {
  it("finds shared identities and same names, and forgets pairs marked different", () => {
    const { crm, people } = setup();
    const a = crm.addContact({ name: "Grace Hopper", company: "Navy", dedup: false });
    const b = crm.addContact({ name: "grace  hopper", company: "navy", dedup: false });
    const c = crm.addContact({ name: "G. Hopper", linkedin_url: "linkedin.com/in/ghopper", dedup: false });
    const d = crm.addContact({ name: "Grace B. Hopper", linkedin_url: "https://linkedin.com/in/GHopper/", dedup: false });
    crm.addContact({ name: "Grace", dedup: false });
    crm.addContact({ name: "Grace", dedup: false });

    const pairs = people.duplicates();
    const key = (x: string, y: string) => [x, y].sort().join("|");
    const found = new Map(pairs.map((p) => [key(p.a.id, p.b.id), p]));
    expect(found.get(key(c.id, d.id))!.reasons).toEqual([expect.stringMatching(/^same linkedin: .*ghopper/i)]);
    expect(found.get(key(c.id, d.id))!.score).toBeGreaterThanOrEqual(0.95);
    expect(found.get(key(a.id, b.id))!).toMatchObject({ score: 0.8, reasons: ["same name and company"] });
    // A lone first name is not evidence.
    expect(pairs).toHaveLength(2);

    people.markDistinct(b.id, a.id);
    expect(people.duplicates().map((p) => key(p.a.id, p.b.id))).toEqual([key(c.id, d.id)]);
  });

  it("tells a person who changed jobs from a namesake, through the facts", () => {
    const { db, crm, people } = setup();
    runMigrations(db as never, "brain", brainMigrations);
    const facts = new FactStore(db as never, () => null);
    const old = crm.addContact({ name: "Lucía Ferreyra", email: "lucia@andina.example", company: "Andina", dedup: false });
    const moved = crm.addContact({ name: "Lucia Ferreyra", email: "lucia@delta.example", company: "Delta Norte", dedup: false });
    const namesake = crm.addContact({ name: "Lucía Ferreyra", email: "lf@omega.example", company: "Omega", dedup: false });
    const key = (x: string, y: string) => [x, y].sort().join("|");

    // Before Kernl knows she moved: a same-name hint only, below the default 0.5.
    expect(people.duplicates().every((p) => p.score === 0.4)).toBe(true);

    facts.assert({ subject: `Person:${old.id}`, predicate: "works_at", object: "Andina", validFrom: "2024-01-01" });
    facts.assert({ subject: `Person:${old.id}`, predicate: "works_at", object: "Delta Norte", validFrom: "2026-11-01" });
    const found = new Map(people.duplicates().map((p) => [key(p.a.id, p.b.id), p]));
    expect(found.get(key(old.id, moved.id))).toMatchObject({
      score: 0.85,
      reasons: ["same name; Delta Norte is where Lucía Ferreyra works, per the facts"],
    });
    expect(found.get(key(old.id, namesake.id))!.score).toBe(0.4);
    expect(found.get(key(moved.id, namesake.id))!.score).toBe(0.4);
  });
});

describe("merge", () => {
  it("moves references, identities and facts, fills gaps and keeps a snapshot", async () => {
    const { db, crm, people } = setup();
    runMigrations(db as never, "notes", notesMigrations);
    runMigrations(db as never, "brain", brainMigrations);
    db.exec(`CREATE TABLE event_attendees (id TEXT PRIMARY KEY, event_id TEXT, contact_id TEXT, UNIQUE(event_id, contact_id));
             CREATE TABLE events (id TEXT PRIMARY KEY, organizer_contact_id TEXT);`);

    const keep = crm.addContact({ name: "Ada Lovelace", email: "ada@home.org", notes: "met at the salon", dedup: false });
    const gone = crm.addContact({ name: "Ada", email: "ada@work.com", phone: "+44 20 7946 0000", company: "Analytical", notes: "work contact", dedup: false });
    crm.logInteraction({ contact_id: gone.id, type: "email", summary: "draft", date: "2026-11-01" });
    db.prepare("INSERT INTO notes (id, title, body, tags, contact_id, created_at, updated_at) VALUES ('n1', 't', '', '', ?, 'x', 'x')").run(gone.id);
    db.exec(`INSERT INTO event_attendees VALUES ('a1', 'e1', '${keep.id}'), ('a2', 'e1', '${gone.id}'), ('a3', 'e2', '${gone.id}');
             INSERT INTO events VALUES ('e9', '${gone.id}');`);
    new FactStore(db as never).assert({ subject: `Person:${gone.id}`, predicate: "works_at", object: "Analytical" });

    const r = (await people.merge(keep.id, gone.id))!;
    expect(r.kept).toMatchObject({ name: "Ada Lovelace", email: "ada@home.org", company: "Analytical", last_interaction: "2026-11-01" });
    expect(r.kept.notes).toBe("met at the salon\n\nwork contact");
    expect(r.moved).toMatchObject({ "interactions.contact_id": 1, "notes.contact_id": 1, "event_attendees.contact_id": 1, "events.organizer_contact_id": 1, facts: 1 });

    expect(crm.getById(gone.id)).toBeFalsy();
    expect(db.prepare("SELECT event_id FROM event_attendees WHERE contact_id = ? ORDER BY event_id").all(keep.id)).toEqual([{ event_id: "e1" }, { event_id: "e2" }]);
    expect(people.identities(keep.id).map((i) => i.value_norm).sort()).toEqual(["+442079460000", "ada@home.org", "ada@work.com"]);
    expect(crm.findExisting(undefined, "ada@work.com")?.id).toBe(keep.id);
    expect(db.prepare("SELECT subject FROM facts").get()).toEqual({ subject: `Person:${keep.id}` });
    const snap = db.prepare("SELECT snapshot FROM contact_merges WHERE kept_id = ?").get(keep.id) as { snapshot: string };
    expect(JSON.parse(snap.snapshot).email).toBe("ada@work.com");
    expect(await people.merge(keep.id, gone.id)).toBeNull();
  });
});

describe.skipIf(!relateClientInstalled())("people in the graph", () => {
  it("merge moves the absorbed Person's relationships; person 360 reads across modules", async () => {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    const { db, crm, people } = setup(() => g);
    const keep = crm.addContact({ name: "Ada Lovelace", email: "ada@home.org", dedup: false });
    const gone = crm.addContact({ name: "Ada", email: "ada@work.com", dedup: false });
    const babbage = crm.addContact({ name: "Charles Babbage", dedup: false });
    await Bun.sleep(20); // the CRM writes the graph fire-and-forget
    await g.run(`MATCH (a:Person {id: $gone}), (b:Person {id: $b}), (k:Person {id: $keep})
                 CREATE (a)-[:KNOWS {type: 'colleague'}]->(b), (b)-[:KNOWS {type: 'friend'}]->(a),
                        (:Email {gmail_id: 'g1', subject: 'Engine'})<-[:SENT]-(a), (a)-[:KNOWS]->(k),
                        (:Fact {id: 'f1', subject: 'Person:' + $gone})-[:ABOUT]->(a)`,
      { gone: gone.id, b: babbage.id, keep: keep.id });

    await people.merge(keep.id, gone.id);
    const fact = (await g.run("MATCH (f:Fact {id: 'f1'})-[:ABOUT]->(p:Person) RETURN f.subject AS s, p.id AS p")).records[0];
    expect([fact.get("s"), fact.get("p")]).toEqual([`Person:${keep.id}`, keep.id]);
    const rels = (await g.run(
      `MATCH (k:Person {id: $id})-[r]-(m) RETURN type(r) AS t, startNode(r) = k AS out, coalesce(m.name, m.subject) AS n, r.type AS rt ORDER BY t, n, out`,
      { id: keep.id },
    )).records.map((r) => r.toObject());
    expect(rels.filter((r) => r.t !== "ABOUT")).toEqual([
      { t: "KNOWS", out: false, n: "Charles Babbage", rt: "friend" },
      { t: "KNOWS", out: true, n: "Charles Babbage", rt: "colleague" },
      { t: "SENT", out: true, n: "Engine", rt: null },
    ]);
    expect(Number((await g.run("MATCH (p:Person {id: $id}) RETURN count(p) AS n", { id: gone.id })).records[0].get("n"))).toBe(0);

    db.exec(`CREATE TABLE google_emails (gmail_id TEXT, subject TEXT, from_email TEXT, to_emails TEXT, cc_emails TEXT, date TEXT);
             INSERT INTO google_emails VALUES ('g1', 'Engine', 'ADA@work.com', 'me@x.org', '', '2026-11-02'),
                                              ('g2', 'Re: Engine', 'me@x.org', 'ada@home.org', '', '2026-11-03'),
                                              ('g3', 'Other', 'bob@x.org', 'me@x.org', '', '2026-11-04');`);
    const view = (await people.person360(keep.id))!;
    expect(view.identities).toEqual({ email: ["ada@home.org", "ada@work.com"] });
    expect(view.mail).toMatchObject({ total: 2, from_them: 1 });
    expect(view.graph).toEqual(expect.arrayContaining([
      expect.objectContaining({ rel: "KNOWS", label: "Person", count: 1 }),
      expect.objectContaining({ rel: "SENT", out: true, label: "Email", count: 1, sample: ["Engine"] }),
    ]));
    expect(view.merged_from).toHaveLength(1);
    expect(view.calendar).toBeUndefined();
  });

  it("a merge that fails halfway leaves the graph as it was", async () => {
    const real = new RelateGraphDriver();
    real.configure({ path: ":memory:" });
    await real.start();
    // The same driver, except that the merge's last statement fails inside the transaction.
    const g = Object.assign(Object.create(real) as RelateGraphDriver, {
      withTransaction: <T>(fn: (tx: { run: RelateGraphDriver["run"] }) => Promise<T>) =>
        real.withTransaction((tx) =>
          fn({
            run: (cypher: string, params?: Record<string, unknown>) =>
              /MATCH \(f:Fact/.test(cypher) ? Promise.reject(new Error("boom")) : tx.run(cypher, params),
          } as never),
        ),
    });
    const { crm, people } = setup(() => g);
    const keep = crm.addContact({ name: "Ada Lovelace", email: "ada@home.org", dedup: false });
    const gone = crm.addContact({ name: "Ada", email: "ada@work.com", company: "Analytical", dedup: false });
    await Bun.sleep(20);
    await real.run("MATCH (a:Person {id: $gone}) CREATE (a)-[:SENT]->(:Email {gmail_id: 'g1'})", { gone: gone.id });

    const out = await people.merge(keep.id, gone.id);
    expect(out?.moved.graph_relationships).toBeUndefined();
    // SQLite merged; the graph is untouched rather than half-merged.
    const left = (await real.run(
      "MATCH (p:Person) OPTIONAL MATCH (p)-[r:SENT]->() RETURN p.id AS id, p.company AS company, count(r) AS sent ORDER BY id",
    )).records.map((r) => ({ id: r.get("id"), company: r.get("company"), sent: Number(r.get("sent")) }));
    expect(left).toEqual(
      [
        { id: keep.id, company: "", sent: 0 },
        { id: gone.id, company: "Analytical", sent: 1 },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
  });
});

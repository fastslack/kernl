import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { TicketDossiers, ticketRefs, DOSSIER_MAX_CHARS } from "../assets/extensions/agents/agent-advanced/_module/ticket-dossier.js";

describe("ticketRefs", () => {
  it("finds repo#number references, folding sub-parts (web#2712:a-i-b) into their ticket, in order, once", () => {
    const goal = 'You have 3 letters: "TRABAJAR web#2712:a-i-b" (id 1); "REVISAR-MR api#88" (id 2); "CORREGIR web#2712" (id 3).';
    expect(ticketRefs(goal)).toEqual(["web#2712", "api#88"]);
  });
  it("ignores colour codes, anchors and bare numbers", () => {
    expect(ticketRefs("colour #ff0000, see #section, issue 1234, page.html#top")).toEqual([]);
  });
});

describe("TicketDossiers", () => {
  let db: Database;
  let calls: Array<{ system: string; user: string }>;
  let reply: (user: string) => string;
  let d: TicketDossiers;
  const run = (over: Partial<Parameters<TicketDossiers["afterRun"]>[0]> = {}) => ({
    scope: "office-1", projectId: "p1", runId: "r1", agentName: "Resolver",
    goal: 'Letters: "TRABAJAR web#2712" (id 1)', status: "completed", steps: 40,
    result: "Fixed the study name in StudyList.tsx; e2e red on DEV, green on preview. Sent mr_open.", error: "",
    ...over,
  });

  beforeEach(() => {
    db = new Database(":memory:");
    calls = [];
    reply = () => JSON.stringify({ "web#2712": "Estado: MR abierto.\nArchivos: StudyList.tsx" });
    d = new TicketDossiers(db as any, async (p) => { calls.push(p); return reply(p.user); });
  });

  it("writes a dossier for each ticket a finished run worked on", async () => {
    expect(await d.afterRun(run())).toBe(1);
    const got = d.get("office-1", "p1", "web#2712")!;
    expect(got.content).toContain("StudyList.tsx");
    expect(got.runs).toBe(1);
    expect(calls[0].user).toContain("Fixed the study name");
  });

  it("merges with what it already knew: the previous dossier goes to the update", async () => {
    await d.afterRun(run());
    reply = () => JSON.stringify({ "web#2712": "Estado: QA pidió cambios." });
    await d.afterRun(run({ runId: "r2", result: "QA objected: e2e never reached the fix." }));
    expect(calls[1].user).toContain("Estado: MR abierto.");
    const got = d.get("office-1", "p1", "web#2712")!;
    expect(got.content).toBe("Estado: QA pidió cambios.");
    expect(got.runs).toBe(2);
  });

  it("puts the dossiers of the tickets a run is about in its prompt, and nothing for unknown tickets", async () => {
    await d.afterRun(run());
    const block = d.promptBlock("office-1", "p1", 'Letters: "CORREGIR web#2712:a" (id 9); "TRABAJAR web#9999" (id 10)');
    expect(block).toContain("web#2712");
    expect(block).toContain("StudyList.tsx");
    expect(block).not.toContain("web#9999");
    expect(block.toLowerCase()).toContain("do not re-");
    expect(d.promptBlock("office-1", "p1", "nothing about tickets here")).toBe("");
  });

  it("keeps offices and projects apart", async () => {
    await d.afterRun(run());
    expect(d.promptBlock("office-2", "p1", "web#2712")).toBe("");
    expect(d.promptBlock("office-1", "p2", "web#2712")).toBe("");
  });

  it("skips runs that did no work: no call, no dossier", async () => {
    expect(await d.afterRun(run({ steps: 1 }))).toBe(0);
    expect(await d.afterRun(run({ result: "", error: "" }))).toBe(0);
    expect(await d.afterRun(run({ goal: "no ticket here" }))).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("learns from failures too: the error goes to the update", async () => {
    await d.afterRun(run({ status: "failed", result: "", error: "Reached maximum number of turns (30)" }));
    expect(calls[0].user).toContain("maximum number of turns");
  });

  it("caps a dossier's size and reads a fenced or chatty JSON answer", async () => {
    reply = () => "Here it is:\n```json\n" + JSON.stringify({ "web#2712": "x".repeat(DOSSIER_MAX_CHARS * 2) }) + "\n```";
    await d.afterRun(run());
    expect(d.get("office-1", "p1", "web#2712")!.content.length).toBeLessThanOrEqual(DOSSIER_MAX_CHARS + 1);
  });

  it("an unreadable answer or a failing model leaves the old dossier as it was", async () => {
    await d.afterRun(run());
    reply = () => "sorry, no JSON";
    expect(await d.afterRun(run({ runId: "r2" }))).toBe(0);
    d = new TicketDossiers(db as any, async () => { throw new Error("model down"); });
    expect(await d.afterRun(run({ runId: "r3" }))).toBe(0);
    expect(d.get("office-1", "p1", "web#2712")!.content).toContain("StudyList.tsx");
  });

  it("two runs finishing at once on the same ticket do not lose an update", async () => {
    let n = 0;
    reply = (user) => JSON.stringify({ "web#2712": `${user.includes("v1") ? "v1" : "v2"} after ${++n}` });
    await Promise.all([d.afterRun(run({ runId: "a", result: "v1 done" })), d.afterRun(run({ runId: "b", result: "v2 done" }))]);
    expect(calls[1].user).toMatch(/after 1/);   // the second update saw the first one's dossier
    expect(d.get("office-1", "p1", "web#2712")!.runs).toBe(2);
  });

  it("a run about many tickets only updates the first few", async () => {
    const goal = Array.from({ length: 9 }, (_, i) => `web#${100 + i}`).join(" ");
    reply = (user) => JSON.stringify(Object.fromEntries(ticketRefs(user).map((r) => [r, "ok"])));
    const n = await d.afterRun(run({ goal }));
    expect(n).toBeLessThanOrEqual(4);
  });
});

describe("TicketDossiers — overlapping runs", () => {
  it("a run on two tickets and one on one of them, finishing together, both land on the shared ticket", async () => {
    const db = new Database(":memory:");
    const seen: string[] = [];
    const d = new TicketDossiers(db as any, async ({ user }) => {
      seen.push(user);
      const refs = user.match(/^Tickets: (.*)$/m)![1].split(", ");
      return JSON.stringify(Object.fromEntries(refs.map((r) => [r, `${r} v${seen.length}`])));
    });
    const base = { scope: "o", projectId: null, agentName: "A", status: "completed", steps: 9, result: "did it", error: "" };
    await Promise.all([
      d.afterRun({ ...base, runId: "a", goal: "web#1 web#2" }),
      d.afterRun({ ...base, runId: "b", goal: "web#1" }),
    ]);
    expect(seen[1]).toContain("web#1 v1");             // the second update read the first one's result
    expect(d.get("o", null, "web#1")!.runs).toBe(2);
  });
});

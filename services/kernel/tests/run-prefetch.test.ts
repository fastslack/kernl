import { describe, it, expect } from "bun:test";
import { letterIds, learnSkillPrefetch, prefetchBlock } from "../assets/extensions/agents/agent-advanced/_module/run-prefetch.js";

describe("letterIds", () => {
  it("are the ids a wake goal names", () => {
    expect(letterIds('2 letters: "REVISAR-MR web#1" (id 7ebbaea2-c443-4dfa-97e9-3d03f8041061); "JOB-OK x" (id 21c3f2f7-03f7-46b0-a390-40f8382fbf0b).'))
      .toEqual(["7ebbaea2-c443-4dfa-97e9-3d03f8041061", "21c3f2f7-03f7-46b0-a390-40f8382fbf0b"]);
    expect(letterIds("no letters")).toEqual([]);
  });
});

describe("learnSkillPrefetch", () => {
  const load = (runId: string, slug: string, file?: string) => ({ run_id: runId, tool_name: "mcp__kernel__kernel_skill_load", tool_input: JSON.stringify(file ? { slug, file } : { slug }) });
  it("picks the skill files the agent loads in most of its runs of that kind", () => {
    const steps = [
      ...Array.from({ length: 8 }, (_, i) => load(`r${i}`, "office", "lessons.md")),
      ...Array.from({ length: 3 }, (_, i) => load(`r${i}`, "clinic", "lessons.md")),
      load("r0", "office", "lessons.md"),   // twice in one run counts once
    ];
    expect(learnSkillPrefetch(steps, 10)).toEqual([{ slug: "office", file: "lessons.md" }]);
  });
  it("needs a few runs before trusting a habit", () => {
    expect(learnSkillPrefetch([load("r0", "office", "lessons.md")], 1)).toEqual([]);
  });
  it("ignores other tools and unreadable inputs", () => {
    expect(learnSkillPrefetch([{ run_id: "r0", tool_name: "Bash", tool_input: "{}" }, { run_id: "r1", tool_name: "kernel_skill_load", tool_input: "not json" }], 10)).toEqual([]);
  });
});

describe("prefetchBlock", () => {
  const letters = [
    { id: "a1", subject: "JOB-OK qa_controls web#1", body: "green ".repeat(2000), from: "Host" },
  ];
  const directory = [{ name: "Acme Integrador", id: "d0d9" }, { name: "Acme QA Web", id: "q1" }];
  const skills = [{ slug: "office", file: "lessons.md", text: "Rule one." }];

  it("hands the run its letters, the office's exact names and the skill files it always loads, saying not to fetch them again", () => {
    const b = prefetchBlock({ letters, directory, skills });
    expect(b).toContain("JOB-OK qa_controls web#1");
    expect(b).toContain("a1");
    expect(b).toContain("Acme Integrador");
    expect(b).toContain("d0d9");
    expect(b).toContain("Rule one.");
    expect(b).toMatch(/do not (call|fetch)/i);
    expect(b).toContain("message_ids");
  });
  it("keeps long letters short", () => {
    expect(prefetchBlock({ letters, directory: [], skills: [] }).length).toBeLessThan(5000);
  });
  it("is empty when there is nothing to hand", () => {
    expect(prefetchBlock({ letters: [], directory: [], skills: [] })).toBe("");
  });
});

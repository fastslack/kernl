/**
 * What the operator reads when a run dies.
 *
 * A failed Claude Code run used to write nothing to the agent's thread. The
 * chat panel only falls back to the run row when the thread holds no agent
 * message at all, so the first failure on a fresh agent surfaced and every
 * failure after that vanished — the operator sent a message, got no reply and
 * no error, and reasonably concluded the agent had stopped working.
 *
 * The note that fixes that has to be legible on its own, because it lands in a
 * chat thread hours later with no log beside it. "Reached maximum number of
 * turns (15)" is accurate and tells a non-author nothing.
 */
import { describe, it, expect } from "bun:test";
import { failureNote } from "../assets/extensions/agents/agent-advanced/_module/failure-note.js";

describe("failureNote", () => {
  it("marks the note so the panel can tell it from an answer", () => {
    // The native executor already writes `[Error] …`; matching it keeps one
    // shape in the thread rather than two that render differently.
    expect(failureNote("something broke")).toStartWith("[Error]");
  });

  it("keeps the original text", () => {
    expect(failureNote("Credit balance is too low")).toContain("Credit balance is too low");
  });

  it("explains running out of turns, which is otherwise unreadable", () => {
    const note = failureNote("Claude Code returned an error result: Reached maximum number of turns (15)");
    expect(note).toContain("15");
    // The operator needs to know it is a budget, that work may already be on
    // screen, and which knob moves it.
    expect(note.toLowerCase()).toContain("step");
    expect(note).toContain("max_iterations");
  });

  it("reads the turn count whatever wording the SDK uses around it", () => {
    expect(failureNote("Reached maximum number of turns (60)")).toContain("60");
    expect(failureNote("error_max_turns: reached max turns (8)")).toContain("8");
  });

  it("points at billing when the CLI died over credit", () => {
    const note = failureNote("Credit balance is too low");
    expect(note.toLowerCase()).toMatch(/credit|billing|balance/);
  });

  it("says something useful when the subprocess died mute", () => {
    const note = failureNote("Claude Code process exited with code 1");
    expect(note.length).toBeGreaterThan("[Error] Claude Code process exited with code 1".length);
  });

  it("survives an empty or missing error rather than writing a bare marker", () => {
    // An empty note in the thread is the same silence this exists to end.
    expect(failureNote("")).toContain("no reason");
    expect(failureNote(undefined)).toContain("no reason");
  });

  it("trims a runaway error so one failure cannot flood the thread", () => {
    const note = failureNote("x".repeat(5000));
    expect(note.length).toBeLessThan(1200);
  });

  it("passes an ordinary error through without inventing advice", () => {
    const note = failureNote("Tool kernel_scene_add failed: there is no piece with that id");
    expect(note).toBe("[Error] Tool kernel_scene_add failed: there is no piece with that id");
  });
});

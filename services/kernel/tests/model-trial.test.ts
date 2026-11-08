import { describe, it, expect } from "bun:test";
import { modelChoice, type ModelSample } from "../assets/extensions/agents/agent-advanced/_module/model-trial.js";

const DEF = "claude-sonnet-5-5", CHEAP = "claude-haiku-5-5";
const runs = (n: number, model: string, ok = true): ModelSample[] => Array.from({ length: n }, () => ({ model, ok, maxed: false }));

// Newest first, as the table reads them.
describe("modelChoice", () => {
  it("without enough history on the usual model there is no trial", () => {
    expect(modelChoice(runs(10, DEF), DEF, CHEAP).model).toBe(DEF);
  });
  it("a kind that goes well on the usual model tries the cheap one in one run of four", () => {
    const picks = [0, 1, 2, 3].map((k) => modelChoice(runs(20 + k, DEF), DEF, CHEAP).model);
    expect(picks.filter((m) => m === CHEAP)).toHaveLength(1);
  });
  it("a kind that often fails is not tried", () => {
    const h = [...runs(15, DEF), ...runs(5, DEF, false)];
    expect([0, 1, 2, 3].every((k) => modelChoice([...runs(k, DEF), ...h], DEF, CHEAP).model === DEF)).toBe(true);
  });
  it("the cheap model failed last time: the next run goes back to the usual one", () => {
    const h = [{ model: CHEAP, ok: false, maxed: false }, ...runs(30, DEF)];
    expect(modelChoice(h, DEF, CHEAP)).toMatchObject({ model: DEF, reason: "escalated" });
  });
  it("after going back once, the trial goes on", () => {
    const h = [...runs(3, DEF), { model: CHEAP, ok: false, maxed: false }, ...runs(28, DEF)];
    expect(modelChoice(h, DEF, CHEAP)).toMatchObject({ model: CHEAP, reason: "trial" });
  });
  it("three cheap failures end the trial before ten tries", () => {
    const h = [...runs(3, DEF), { model: CHEAP, ok: false, maxed: false }, ...runs(3, DEF), { model: CHEAP, ok: false, maxed: false },
      ...runs(3, DEF), { model: CHEAP, ok: false, maxed: false }, ...runs(30, DEF)];
    expect([0, 1, 2, 3].every((k) => modelChoice([...runs(k, DEF), ...h], DEF, CHEAP).reason === "demoted")).toBe(true);
  });
  it("ten good cheap runs, as good as the usual model: the cheap one stays", () => {
    const h = [...runs(10, CHEAP), ...runs(30, DEF)];
    expect(modelChoice(h, DEF, CHEAP)).toMatchObject({ model: CHEAP, reason: "promoted" });
  });
  it("cheap runs that do worse than the usual model end the trial", () => {
    const h = [{ model: CHEAP, ok: true, maxed: false }, ...runs(6, CHEAP), ...runs(4, CHEAP, false), ...runs(30, DEF)];
    expect([0, 1, 2, 3].every((k) => modelChoice([...runs(k, DEF), ...h], DEF, CHEAP).model === DEF)).toBe(true);
  });
  it("a run that ran out of turns counts as a failure", () => {
    const h = [{ model: CHEAP, ok: true, maxed: true }, ...runs(30, DEF)];
    expect(modelChoice(h, DEF, CHEAP).model).toBe(DEF);
  });
});

import { describe, it, expect } from "vitest";
import { OpinionError, askOpinion, buildOpinionPrompt } from "../src/modules/agents/question-opinion.js";
import type { AgentQuestion } from "../src/modules/agents/service.js";

const q: AgentQuestion = {
  id: "q1", from_agent_id: "a1", flow_id: "f1", meeting_id: "", run_id: "r1",
  question: "¿Qué falta para listar deals?", context: "error: Falta el proyecto",
  options: [{ label: "Configurar env" }, { label: "Bug del kernel" }],
  status: "pending", selected_option: "", selected_index: -1, answered_note: "", answered_at: null,
  answered_by: "", chief_note: "no pude confirmar la causa", triage_started_at: null, created_at: "2026-10-06T00:00:00Z",
};

describe("question opinion", () => {
  it("puts the question, the chief's reason, the context and numbered options in the prompt", () => {
    const p = buildOpinionPrompt(q, { name: "Closer", description: "cierra ventas" });
    expect(p).toContain("Closer — cierra ventas");
    expect(p).toContain("no pude confirmar la causa");
    expect(p).toContain("Falta el proyecto");
    expect(p).toContain("1. Configurar env");
    expect(p).toContain("2. Bug del kernel");
  });

  it("maps the 1-based option to a 0-based index and tags the call", async () => {
    let caller = "";
    const o = await askOpinion(q, undefined, "es", async (opts) => {
      caller = opts.caller;
      return { answer: " Usá project ", reasoning: "porque sí", matches_option: 2 };
    });
    expect(caller).toBe("agents:question-opinion");
    expect(o).toEqual({ answer: "Usá project", reasoning: "porque sí", matches_option: 1 });
  });

  it("drops an option number outside the list", async () => {
    const o = await askOpinion(q, undefined, "es", async () => ({ answer: "x", matches_option: 7 }));
    expect(o.matches_option).toBeNull();
  });

  it("refuses a reply without an answer", async () => {
    await expect(askOpinion(q, undefined, "es", async () => ({ reasoning: "?" }))).rejects.toThrow("no answer");
  });
});

describe("when the model does not get to the JSON", () => {
  const q = {
    id: "q1", from_agent_id: "a", question: "¿Dónde está Miniatura?", context: "", chief_note: "",
    options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }],
  } as unknown as AgentQuestion;

  it("retries once with room to finish and a stricter instruction", async () => {
    // nemotron-3-super, 2026-10-08: cut at 700 tokens mid-thought.
    const calls: Array<{ system: string; maxTokens: number }> = [];
    const o = await askOpinion(q, undefined, "es", async (opts) => {
      calls.push(opts);
      if (calls.length === 1) throw new Error("the model did not return JSON. It replied: We need to produce JSON with answer…");
      return { answer: "Pedile el path completo", reasoning: "falta el dato", matches_option: 1 };
    });
    expect(o.answer).toBe("Pedile el path completo");
    expect(calls).toHaveLength(2);
    expect(calls[0].maxTokens).toBeGreaterThanOrEqual(2000);
    expect(calls[1].maxTokens).toBeGreaterThan(calls[0].maxTokens);
    expect(calls[1].system).toContain("únicamente con el objeto JSON");
  });

  it("gives up after the retry with a reason the card can explain", async () => {
    const err = await askOpinion(q, undefined, "es", async () => { throw new Error("the model did not return JSON. It replied: …"); }).catch((e) => e);
    expect(err).toBeInstanceOf(OpinionError);
    expect(err.reason).toBe("no_answer");
  });

  it("does not retry when no model answered at all", async () => {
    let n = 0;
    const err = await askOpinion(q, undefined, "es", async () => { n++; throw new Error("No LLM provider is configured"); }).catch((e) => e);
    expect(n).toBe(1);
    expect(err.reason).toBe("unavailable");
  });
});

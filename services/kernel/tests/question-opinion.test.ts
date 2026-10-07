import { describe, it, expect } from "vitest";
import { askOpinion, buildOpinionPrompt } from "../src/modules/agents/question-opinion.js";
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

import { describe, it, expect } from "bun:test";
import {
  buildInvestigationGoal, failureOf, forgeProjectOf, parseOpinion, INVESTIGATOR_PROMPT,
} from "../src/modules/agents/question-opinion.js";
import { parseQuestionRefs } from "../src/modules/agents/question-refs.js";
import type { AgentQuestion } from "../src/modules/agents/service.js";

const q: AgentQuestion = {
  id: "q1", from_agent_id: "a1", flow_id: "", meeting_id: "", run_id: "",
  question: "¿El profesional ve «rechazado» cuando el familiar rechaza? (web#2595, api!95)",
  context: "El MR api!95 cambia toLink en app/services/family.js:120.",
  options: [{ label: "Mostrar rechazado" }, { label: "Mostrar pendiente" }, { label: "Ocultar" }, { label: "Preguntar" }],
  status: "pending", selected_option: "", selected_index: -1, answered_note: "", answered_at: null,
  answered_by: "", chief_note: "Es una decisión de privacidad", triage_started_at: null, created_at: "2026-10-14T03:00:00Z",
  opinion_status: "", opinion_run_id: "", opinion: null, opinion_error: "", opinion_at: null, owed_at: null, reminded_at: null, for_operator: false,
};

describe("buildInvestigationGoal", () => {
  const repos = [
    { name: "web", remote_url: "git@gitlab.com:heural/heural-web.git" },
    { name: "api", remote_url: "https://gitlab.com/heural/oauth2-server.git" },
  ];
  const goal = buildInvestigationGoal(q, { name: "Resolver" }, parseQuestionRefs(q.question, q.chief_note, q.context), repos);

  it("carries the question id, the chief's reason and the options numbered from 1", () => {
    expect(goal).toContain("question_id: q1");
    expect(goal).toContain("Motivo del chief para escalarla: Es una decisión de privacidad");
    expect(goal).toContain("1. Mostrar rechazado");
    expect(goal).toContain("4. Preguntar");
  });

  it("maps each reference to its forge project so the investigator knows what to read first", () => {
    expect(goal).toContain('issue web#2595: project "gitlab.com/heural/heural-web", number 2595');
    expect(goal).toContain('MR api!95: project "gitlab.com/heural/oauth2-server", number 95');
    expect(goal).toContain("archivo app/services/family.js:120");
  });

  it("lists the other open questions with their options, not itself, each cut short", () => {
    const others = [
      { id: "q1", agent: "Resolver", question: "self", options: ["A"] },
      { id: "q2", agent: "Heural Integrador", question: "web#2595 (web!311): espera al operador", options: ["Reanudar", "Lo veo yo"] },
      { id: "q3", agent: "QA", question: "y".repeat(1000), options: ["Sí"] },
    ];
    const g = buildInvestigationGoal(q, undefined, parseQuestionRefs(""), [], others);
    expect(g).toContain("Otras preguntas abiertas");
    expect(g).toContain("- question_id q2 — Heural Integrador: web#2595 (web!311): espera al operador");
    expect(g).toContain("    2. Lo veo yo");
    expect(g).not.toContain("question_id q1 —");
    expect(g).not.toContain("y".repeat(401));
    expect(buildInvestigationGoal(q, undefined, parseQuestionRefs(""), [])).not.toContain("Otras preguntas abiertas");
  });

  it("no longer cuts the context at 6000 characters", () => {
    const long = { ...q, context: "x".repeat(20_000) };
    expect(buildInvestigationGoal(long, undefined, parseQuestionRefs(""), []).length).toBeGreaterThan(20_000);
  });
});

describe("the investigator's instructions", () => {
  it("say the chief's options may all be wrong and never to send it to someone else with access", () => {
    expect(INVESTIGATOR_PROMPT.es).toContain("pueden estar todas mal");
    expect(INVESTIGATOR_PROMPT.es).toContain("Nunca recomiendes \"que lo haga otra persona");
    expect(INVESTIGATOR_PROMPT.en).toContain("may all be wrong");
  });
});

describe("parseOpinion", () => {
  it("reads the new format, with the option extended by conditions", () => {
    const o = parseOpinion(JSON.stringify({
      answer: "Opción 1, y además: 1) …", reasoning: "api!95 descripción", matches_option: 1, extends_option: true,
      evidence: ["api!95 descripción, sección 'Al rechazar'"], unverified: [], needs_human: ["correr la query en PROD"],
    }), 4);
    expect(o).toEqual({
      answer: "Opción 1, y además: 1) …", reasoning: "api!95 descripción", matches_option: 0, extends_option: true,
      evidence: ["api!95 descripción, sección 'Al rechazar'"], unverified: [], needs_human: ["correr la query en PROD"],
      also_answers: [],
    });
  });

  it("still takes the old format, with the new lists empty", () => {
    const o = parseOpinion('{"answer":"Hacé B","reasoning":"r","matches_option":2}', 4);
    expect(o).toEqual({ answer: "Hacé B", reasoning: "r", matches_option: 1, extends_option: false, evidence: [], unverified: [], needs_human: [], also_answers: [] });
  });

  it("finds the JSON after prose or inside a fence", () => {
    expect(parseOpinion('Listo, esta es mi opinión:\n```json\n{"answer":"A"}\n```', 4)?.answer).toBe("A");
    expect(parseOpinion('Investigué todo. {"answer":"B","matches_option":null}', 4)?.answer).toBe("B");
  });

  it("an out-of-range option is none, and extends_option needs an option", () => {
    const o = parseOpinion('{"answer":"x","matches_option":9,"extends_option":true}', 4);
    expect(o?.matches_option).toBeNull();
    expect(o?.extends_option).toBe(false);
  });

  it("also_answers: only questions still open, once each, with an option of THAT question or a free answer", () => {
    const open = new Map([["q2", 2], ["q3", 4]]);
    const o = parseOpinion(JSON.stringify({
      answer: "A",
      also_answers: [
        { question_id: "q2", option: 1, answer: "Reanudá", why: "mismo MR" },
        { question_id: "q2", option: 2, answer: "dup", why: "" },
        { question_id: "q3", option: 9, answer: "Texto libre", why: "misma causa" },
        { question_id: "q3x", option: 1, answer: "no existe", why: "" },
        { question_id: "q9", option: 1, answer: "ya contestada", why: "" },
      ],
    }), 4, open);
    expect(o?.also_answers).toEqual([
      { question_id: "q2", option: 0, answer: "Reanudá", why: "mismo MR" },
      { question_id: "q3", option: null, answer: "Texto libre", why: "misma causa" },
    ]);
    // Without an option and without an answer there is nothing to send.
    expect(parseOpinion('{"answer":"A","also_answers":[{"question_id":"q2","option":null}]}', 4, open)?.also_answers).toEqual([]);
  });

  it("no answer → null", () => {
    expect(parseOpinion("no JSON here", 4)).toBeNull();
    expect(parseOpinion('{"reasoning":"only"}', 4)).toBeNull();
  });
});

describe("forgeProjectOf", () => {
  it("turns a remote into host/path, and anything else into ''", () => {
    expect(forgeProjectOf("git@gitlab.com:heural/web.git")).toBe("gitlab.com/heural/web");
    expect(forgeProjectOf("https://github.com/o/r.git")).toBe("github.com/o/r");
    expect(forgeProjectOf("/home/x/repo")).toBe("");
    expect(forgeProjectOf("")).toBe("");
  });
});

describe("failureOf", () => {
  it("a model that cannot be reached is 'unavailable'; anything else 'no_answer'", () => {
    expect(failureOf("Not logged in · Please run /login")).toBe("unavailable");
    expect(failureOf("Claude AI usage limit reached|429")).toBe("unavailable");
    expect(failureOf("error_max_turns")).toBe("no_answer");
  });
});

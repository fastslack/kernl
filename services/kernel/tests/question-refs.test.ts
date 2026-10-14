import { describe, it, expect } from "bun:test";
import { parseQuestionRefs, refsEmpty } from "../src/modules/agents/question-refs.js";

describe("parseQuestionRefs", () => {
  it("issues with and without repo, dropping a part suffix", () => {
    const r = parseQuestionRefs("Sobre web#2595:api-1 y el #2600, también api#243.");
    expect(r.issues).toEqual([{ repo: "web", number: 2595 }, { repo: "", number: 2600 }, { repo: "api", number: 243 }]);
  });

  it("merge requests: repo!n, bare !n, 'MR 83'; a bare one next to the qualified one is the same", () => {
    const r = parseQuestionRefs("api!95 cambia toLink; el !95 también; ver MR 83 y !86");
    expect(r.changes).toEqual([{ repo: "api", number: 95 }, { repo: "", number: 86 }, { repo: "", number: 83 }]);
  });

  it("shas need a digit and a letter; plain numbers and words do not count", () => {
    const r = parseQuestionRefs("commit d1c757de y 70096681 y la palabra decade y 1234567 y abcdef1234567890");
    expect(r.shas).toEqual(["d1c757de", "abcdef1234567890"]);
  });

  it("paths with a line, and URLs are not paths", () => {
    const r = parseQuestionRefs("ver app/services/medication/index.js:167 y prescription-admin/index.js, https://gitlab.com/heural/web/-/issues/1");
    expect(r.paths).toEqual([
      { path: "app/services/medication/index.js", line: 167 },
      { path: "prescription-admin/index.js", line: null },
    ]);
  });

  it("joins several texts and dedupes", () => {
    const r = parseQuestionRefs("web#1", null, "web#1 otra vez", undefined);
    expect(r.issues).toEqual([{ repo: "web", number: 1 }]);
    expect(refsEmpty(parseQuestionRefs("nada acá"))).toBe(true);
  });

  it("the three escalated questions of 14/10", () => {
    expect(parseQuestionRefs("web#2595 / api!95 (vínculo con familiar paciente)").changes[0]).toEqual({ repo: "api", number: 95 });
    expect(parseQuestionRefs("web#2600 parte 2 (H-Digest PROD) LAB_EXTRACTION_HIDDEN_BEFORE").issues[0]).toEqual({ repo: "web", number: 2600 });
    expect(parseQuestionRefs("¿Pego la descripción corregida en !83?").changes).toEqual([{ repo: "", number: 83 }]);
  });
});

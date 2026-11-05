import { describe, it, expect } from "bun:test";
import { focusSkillFile, FOCUS_FULL_MAX, runFocusQuery } from "../src/sdk/skill-file-focus.js";

// 05/11: acme-web/lecciones.md (72 KB) and acme-qa/lecciones.md (39 KB) were loaded whole in most runs: a
// quarter of everything the Acme agents read back, carried in context for every later turn.
const header = "# Lecciones guardadas (acme-web)\n\nLas agrega bin/ops skill_lesson.\n\n";
const filler = (i: number) => `- [2026-10-${String(1 + (i % 28)).padStart(2, "0")} web#${2000 + i}] Lección ${i} sobre formularios genéricos y estilos ${"x".repeat(300)} (acme-resolver-1)`;
const big = header + Array.from({ length: 120 }, (_, i) => filler(i)).join("\n") + "\n" +
  "- [2026-11-04 web#2808] El calendario de turnos usa date-fns con la zona de la institución, nunca new Date() suelto. (qa)\n" +
  "  Continúa en una segunda línea sobre el calendario.\n" +
  "- [2026-11-05 web#2820] Último aprendizaje. (qa)\n";

describe("focusSkillFile", () => {
  it("a small file comes whole", () => {
    const small = header + "- [2026-11-01 web#1] una lección\n";
    expect(focusSkillFile(small, "calendario")).toBe(small);
  });

  it("a big lessons file keeps the header, the entries about the task and the latest ones, in file order", () => {
    const out = focusSkillFile(big, "REVISAR-MR web#2808: el calendario de turnos muestra la hora corrida");
    expect(out.length).toBeLessThan(FOCUS_FULL_MAX);
    expect(out.startsWith(header.trim())).toBe(true);
    expect(out).toContain("date-fns con la zona");
    expect(out).toContain("Continúa en una segunda línea"); // an entry keeps its continuation lines
    expect(out).toContain("Último aprendizaje");
    expect(out.indexOf("date-fns")).toBeLessThan(out.indexOf("Último aprendizaje"));
    expect(out).toMatch(/Se muestran \d+ de 122 lecciones/);
    expect(out).toContain('query: "*"');
  });

  it("a query of * gives the whole file", () => {
    expect(focusSkillFile(big, "*")).toBe(big);
  });

  it("a file that is not a list of entries comes whole even when big", () => {
    const prose = "# Guía\n\n" + "Texto corrido. ".repeat(2000);
    expect(focusSkillFile(prose, "calendario")).toBe(prose);
  });
});

describe("runFocusQuery", () => {
  it("a wake goal names only the subject: the letters it names bring their body", () => {
    const goal = 'You have 1 unacknowledged letter(s) in your office inbox: "APROBAR web#2822:a" (id 9f253b08-0577-40d6-a821-7e17db39e81b). Handle it.';
    const q = runFocusQuery(goal, (id) => (id === "9f253b08-0577-40d6-a821-7e17db39e81b" ? { subject: "APROBAR web#2822:a", body: "El calendario de turnos" } : null));
    expect(q).toContain("APROBAR web#2822:a");
    expect(q).toContain("El calendario de turnos");
  });
  it("a goal without letters is the query as is", () => {
    expect(runFocusQuery("Revisá el calendario", () => null)).toBe("Revisá el calendario");
  });
});

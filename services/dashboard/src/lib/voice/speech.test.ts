import { describe, it, expect } from "bun:test";
import { SentenceSplitter, findCut } from "./speech.js";

const feedAll = (deltas: string[]) => {
	const s = new SentenceSplitter();
	const out: string[] = [];
	for (const d of deltas) out.push(...s.feed(d));
	out.push(...s.end());
	return out;
};

describe("SentenceSplitter", () => {
	it("hands out the first sentence as soon as it is complete", () => {
		const s = new SentenceSplitter();
		expect(s.feed("Hoy tenés tres reuniones y dos tareas vencidas")).toEqual([]);
		expect(s.feed(". La primera es a las diez")).toEqual(["Hoy tenés tres reuniones y dos tareas vencidas."]);
		expect(s.end()).toEqual(["La primera es a las diez"]);
	});

	it("merges short sentences instead of speaking them one word at a time", () => {
		expect(feedAll(["Sí. Listo. Ya está agendado para el martes a las diez de la mañana. Avisame."]))
			.toEqual(["Sí. Listo. Ya está agendado para el martes a las diez de la mañana.", "Avisame."]);
	});

	it("does not cut inside numbers or file names", () => {
		expect(findCut("La versión 1.5 de kernel.db pesa 2.3 GB y sigue creciendo cada día")).toBe(0);
	});

	it("skips code fences whole, even split across deltas", () => {
		const out = feedAll(["Corré esto:\n```", "bash\nnpm run reload:local\n", "```\nY después avisame cómo te fue con el deploy."]);
		expect(out).toEqual(["Corré esto:", "Y después avisame cómo te fue con el deploy."]);
	});

	it("drops an unclosed fence at the end", () => {
		expect(feedAll(["Mirá este código que armé para vos:\n```ts\nconst a = 1;"])).toEqual(["Mirá este código que armé para vos:"]);
	});

	it("cuts a run-on paragraph at a space", () => {
		const long = "palabra ".repeat(80);
		const out = feedAll([long]);
		expect(out.length).toBeGreaterThan(1);
		expect(out.every((p) => p.length <= 320)).toBe(true);
	});

	it("treats list items as pieces", () => {
		const out = feedAll(["Para hoy tenés estas cosas pendientes en la agenda\n- Llamar a Ana por el presupuesto\n- Revisar el deploy de la API"]);
		expect(out[0]).toBe("Para hoy tenés estas cosas pendientes en la agenda");
	});
});

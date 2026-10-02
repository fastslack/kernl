import { describe, it, expect } from "bun:test";
import { Endpointer, END_SILENCE_MS, NO_SPEECH_MS } from "./endpoint.js";

/** Feed `[levelDb, durationMs]` segments at 50 ms steps; return the first non-listen decision and when. */
function run(segments: Array<[number, number]>) {
	const e = new Endpointer();
	let t = 0;
	for (const [db, dur] of segments) {
		for (let k = 0; k < dur; k += 50) {
			const d = e.push(db, t);
			if (d !== "listen") return { d, t };
			t += 50;
		}
	}
	return { d: "listen" as const, t };
}

describe("Endpointer", () => {
	it("stops 1.5 s after a loud speaker goes quiet", () => {
		const r = run([[-65, 500], [-20, 2000], [-65, 3000]]);
		expect(r.d).toBe("stop");
		expect(r.t).toBeGreaterThanOrEqual(2500 + END_SILENCE_MS - 100);
		expect(r.t).toBeLessThan(2500 + END_SILENCE_MS + 600);
	});

	it("hears a quiet laptop mic just as well", () => {
		// Voice at −45 dBFS over a −70 dBFS room: what a fixed threshold missed.
		const r = run([[-70, 500], [-45, 2000], [-70, 3000]]);
		expect(r.d).toBe("stop");
	});

	it("does not cut a very quiet mic after the first word", () => {
		// Measured: voice at −54 dBFS over a −86 dBFS room. "hola · qué tal · me escuchás".
		const r = run([[-86, 300], [-54, 400], [-62, 200], [-55, 500], [-63, 150], [-56, 600], [-86, 2500]]);
		expect(r.d).toBe("stop");
		expect(r.t).toBeGreaterThan(2150 + 1400);
	});

	it("works when talking starts the instant the mic opens", () => {
		const r = run([[-22, 2500], [-66, 3000]]);
		expect(r.d).toBe("stop");
	});

	it("keeps listening through a short pause between sentences", () => {
		const r = run([[-65, 500], [-25, 1500], [-65, 900], [-25, 1500], [-65, 400]]);
		expect(r.d).toBe("listen");
	});

	it("gives up on nothing said", () => {
		const r = run([[-62, NO_SPEECH_MS + 500]]);
		expect(r.d).toBe("no-speech");
	});

	it("does not take a noisy room for speech", () => {
		// Steady fan at −40 dBFS, no voice.
		const r = run([[-40, NO_SPEECH_MS + 500]]);
		expect(r.d).toBe("no-speech");
	});
});

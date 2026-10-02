/**
 * When to stop recording on its own: one click starts a message, and the
 * message ends when you stop talking. Fed the live input level every ~50 ms.
 *
 * Relative to the room, not to a fixed level — the same lesson as the
 * kernel's silence gate, where a fixed threshold threw away a real message
 * from a quiet laptop mic. The background is the quietest the input has
 * been; speech is anything 12 dB over it; the message is over after
 * END_SILENCE_MS back near the background. A steady noise that starts
 * mid-message (a fan) can hold it open; MAX_MS and the stop click cover that.
 */

export const END_SILENCE_MS = 1500;
/** Nothing said this long after the click: stop and say so. */
export const NO_SPEECH_MS = 10_000;
/** One message, not a dictation session. */
export const MAX_MS = 90_000;
/** Speech must last this long before a pause can end the message. */
const MIN_SPEECH_MS = 250;

export type EndpointDecision = 'listen' | 'stop' | 'no-speech';

export class Endpointer {
	/** Smoothed level history, one entry per push: [tMs, dB]. ≤ MAX_MS / 50 entries. */
	private history: Array<[number, number]> = [];
	private smoothed = -100;
	private floor = 0;
	/** Loudest smoothed level seen. */
	peakDb = -100;
	private speechMs = 0;

	get heardSpeech(): boolean {
		return this.speechMs >= MIN_SPEECH_MS;
	}

	/** Background estimate in dBFS. */
	get floorDb(): number {
		return this.floor;
	}

	push(levelDb: number, tMs: number): EndpointDecision {
		// Light smoothing so a single click or consonant does not flip state.
		this.smoothed = this.smoothed <= -99 ? levelDb : this.smoothed * 0.6 + levelDb * 0.4;
		this.peakDb = Math.max(this.peakDb, this.smoothed);
		this.history.push([tMs, this.smoothed]);

		// The background is the quietest the input has been so far — which is
		// why everything below is recomputed over the whole history: someone
		// who starts talking the instant they click has no quiet sample yet,
		// and their first words only become "speech" once the first pause
		// shows what the room sounds like.
		this.floor = Math.min(...this.history.map(([, db]) => db));
		// Absolute floors low enough for a mic arriving at −55 dBFS over a −86
		// room (measured: a Scarlett with its gain knob near zero). At −60 the
		// message was cut after "hola" and whisper got near-silence.
		const speechAt = Math.max(this.floor + 12, -72);
		let speechMs = 0;
		let lastSpeechT = -1;
		for (let i = 1; i < this.history.length; i++) {
			const [t, db] = this.history[i];
			if (db > speechAt) {
				speechMs += t - this.history[i - 1][0];
				lastSpeechT = t;
			}
		}
		this.speechMs = speechMs;

		if (tMs >= MAX_MS) return 'stop';
		const quietNow = this.smoothed < Math.max(this.floor + 6, -78);
		if (this.heardSpeech && quietNow && tMs - lastSpeechT >= END_SILENCE_MS) return 'stop';
		if (!this.heardSpeech && tMs >= NO_SPEECH_MS) return 'no-speech';
		return 'listen';
	}
}

/** dBFS → 0..1 for a meter bar (−60 dBFS empty, −6 full). */
export function meterFraction(db: number): number {
	return Math.min(1, Math.max(0, (db + 60) / 54));
}

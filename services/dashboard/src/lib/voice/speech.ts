/**
 * The dashboard half of voice: sending what you said to the kernel, and
 * reading the reply back to you a sentence at a time.
 *
 * Sentence at a time is the point. A reply that streams in over twenty
 * seconds would otherwise be silent for twenty seconds and then speak; cut
 * into sentences, the first one is synthesized and playing while the model is
 * still writing the second.
 */

import { writable } from 'svelte/store';

// ── Talking to the kernel ─────────────────────────────────────────────────

export class VoiceOffError extends Error {}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => {
			const s = String(r.result ?? '');
			resolve(s.slice(s.indexOf(',') + 1));
		};
		r.onerror = () => reject(r.error);
		r.readAsDataURL(blob);
	});
}

async function errorOf(r: Response): Promise<string> {
	try {
		const j = await r.json();
		return j?.error || `HTTP ${r.status}`;
	} catch {
		return `HTTP ${r.status}`;
	}
}

/** How the recording sounded, as the kernel measured it (dBFS). */
export interface AudioLevels {
	seconds: number;
	peakDb: number;
	speechDb: number;
	noiseDb: number;
	snrDb: number;
	voicedFrames: number;
	clippedPct: number;
}

export interface Heard {
	text: string;
	levels: AudioLevels | null;
	engine: string | null;
	ms: number;
}

/** What was said ("" when nothing was), and how it sounded. Throws VoiceOffError when voice is off. */
export async function transcribe(blob: Blob, mime: string): Promise<Heard> {
	// Bearer token: added by the layout's window.fetch interceptor (/api/ URL).
	const r = await fetch('/api/voice/transcribe', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ audio: await blobToBase64(blob), mime_type: mime }),
	});
	if (r.status === 409) throw new VoiceOffError(await errorOf(r));
	if (!r.ok) throw new Error(await errorOf(r));
	const j = (await r.json()) as { text?: string; levels?: AudioLevels | null; engine?: string | null; ms?: number };
	return { text: (j.text ?? '').trim(), levels: j.levels ?? null, engine: j.engine ?? null, ms: j.ms ?? 0 };
}

/**
 * One sentence about what is wrong with the input, or "" when it is fine.
 * Thresholds from the measurements behind the kernel's silence gate: a clear
 * voice sits around −10 to −25 dBFS; under −40 whisper still hears it but the
 * gate is near its floor; under ~15 dB of SNR the background competes.
 */
export function levelAdvice(l: AudioLevels | null, tr: (k: string, p?: Record<string, string | number>) => string): string {
	if (!l) return '';
	if (l.clippedPct >= 1) return tr('voice.level.clipping', { pct: l.clippedPct });
	if (l.voicedFrames < 5) return tr('voice.level.silent', { db: l.speechDb });
	if (l.speechDb < -40) return tr('voice.level.quiet', { db: l.speechDb });
	if (l.snrDb < 15) return tr('voice.level.noisy', { snr: l.snrDb });
	return '';
}

/** Safari before 18.4 cannot play ogg/opus; ask for mp3 there. */
function preferredFormat(): 'ogg' | 'mp3' {
	try {
		return new Audio().canPlayType('audio/ogg; codecs="opus"') ? 'ogg' : 'mp3';
	} catch {
		return 'mp3';
	}
}

/** `voice` overrides the configured one — the Settings picker's preview. */
export async function synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<Blob> {
	const r = await fetch('/api/voice/speak', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text, format: preferredFormat(), ...(voice ? { voice } : {}) }),
		signal,
	});
	if (r.status === 409) throw new VoiceOffError(await errorOf(r));
	if (!r.ok) throw new Error(await errorOf(r));
	return r.blob();
}

// ── Cutting a stream into sentences ───────────────────────────────────────

/** Shorter pieces are merged with the next: one request per "Sí." sounds choppy. */
const MIN_CHUNK = 40;
/** A run-on paragraph is spoken in pieces rather than waited on. */
const MAX_CHUNK = 320;

/**
 * Feed it text as it streams in; it hands back each piece worth speaking as
 * soon as that piece is complete. Code fences are skipped whole — the
 * kernel's speakable filter would drop them anyway, but waiting for a fence
 * to close before speaking the sentence after it is what keeps the order.
 */
export class SentenceSplitter {
	private buf = '';
	private inFence = false;

	feed(delta: string): string[] {
		this.buf += delta;
		const out: string[] = [];
		for (;;) {
			if (this.inFence) {
				const close = this.buf.indexOf('```');
				if (close < 0) return out;
				this.buf = this.buf.slice(close + 3);
				this.inFence = false;
				continue;
			}
			const open = this.buf.indexOf('```');
			const searchIn = open >= 0 ? this.buf.slice(0, open) : this.buf;
			const cut = findCut(searchIn);
			if (cut > 0) {
				const piece = this.buf.slice(0, cut).trim();
				this.buf = this.buf.slice(cut);
				if (piece) out.push(piece);
				continue;
			}
			if (open >= 0) {
				// Everything before the fence is a piece of its own, whatever its length.
				const before = this.buf.slice(0, open).trim();
				if (before) out.push(before);
				this.buf = this.buf.slice(open + 3);
				this.inFence = true;
				continue;
			}
			return out;
		}
	}

	/** Whatever is left once the stream ends. */
	end(): string[] {
		const rest = this.inFence ? '' : this.buf.trim();
		this.buf = '';
		this.inFence = false;
		return rest ? [rest] : [];
	}
}

/**
 * Index just past the first sentence end that leaves a piece of at least
 * MIN_CHUNK characters — the first one, so the first sound comes as early as
 * possible — or a forced cut in a run-on longer than MAX_CHUNK; 0 when the
 * text so far should keep waiting.
 */
export function findCut(text: string): number {
	// A sentence end needs whitespace after it, so "1.5" and "kernel.db" never
	// cut; a blank line or the start of a list item ends a piece too.
	const re = /[.!?…:;](?=\s)|\n\s*\n|\n(?=\s*(?:[-*+•]|\d+[.)])\s)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const end = m.index + m[0].length;
		if (end >= MIN_CHUNK) return end;
	}
	if (text.length > MAX_CHUNK) {
		const space = text.lastIndexOf(' ', MAX_CHUNK);
		return space > MIN_CHUNK ? space : MAX_CHUNK;
	}
	return 0;
}

// ── Playing it back ───────────────────────────────────────────────────────

/** True while something is being read out (or about to be). */
export const speaking = writable(false);
/** The last playback failure, for a one-line notice. Cleared on the next success. */
export const speechError = writable('');

/**
 * Plays pieces in the order they were pushed. Each piece's audio is requested
 * the moment it is pushed, so synthesis of the next overlaps playback of the
 * current one.
 */
class SpeechQueue {
	private queue: Array<Promise<Blob | null>> = [];
	private abort = new AbortController();
	private audio: HTMLAudioElement | null = null;
	private playing = false;
	private generation = 0;

	push(text: string, voice?: string): void {
		const t = text.trim();
		if (!t) return;
		const signal = this.abort.signal;
		const p = synthesize(t, signal, voice).catch((err) => {
			if (signal.aborted) return null;
			speechError.set(err instanceof Error ? err.message : String(err));
			return null;
		});
		// Handled in the loop; this keeps an early rejection from going unhandled.
		p.catch(() => {});
		this.queue.push(p);
		speaking.set(true);
		if (!this.playing) void this.run(this.generation);
	}

	/** Silence now, and drop everything queued. */
	stop(): void {
		this.generation++;
		this.abort.abort();
		this.abort = new AbortController();
		this.queue = [];
		if (this.audio) {
			this.audio.pause();
			this.audio.src = '';
			this.audio = null;
		}
		this.playing = false;
		speaking.set(false);
	}

	private async run(gen: number): Promise<void> {
		this.playing = true;
		while (this.queue.length && gen === this.generation) {
			const blob = await this.queue.shift()!;
			if (gen !== this.generation) return;
			if (!blob) continue;
			speechError.set('');
			await this.play(blob, gen);
		}
		if (gen === this.generation) {
			this.playing = false;
			speaking.set(false);
		}
	}

	private play(blob: Blob, gen: number): Promise<void> {
		return new Promise((resolve) => {
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			this.audio = audio;
			const done = () => {
				URL.revokeObjectURL(url);
				if (this.audio === audio) this.audio = null;
				resolve();
			};
			audio.onended = done;
			audio.onerror = done;
			audio.play().catch((err) => {
				// Autoplay blocked (no gesture since load) — say so once and move on.
				if (gen === this.generation) speechError.set(err instanceof Error ? err.message : String(err));
				done();
			});
		});
	}
}

export const speech = new SpeechQueue();

/** Read a whole reply out loud (already-complete text), optionally in another voice. */
export function speakText(text: string, voice?: string): void {
	const s = new SentenceSplitter();
	for (const piece of [...s.feed(text), ...s.end()]) speech.push(piece, voice);
}

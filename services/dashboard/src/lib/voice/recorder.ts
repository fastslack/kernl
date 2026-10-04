/**
 * Recording one message: one MediaRecorder per message, the microphone
 * released as soon as it ends so the browser's "recording" indicator never
 * lingers. While it records, `levelDb()` reads the live input level, which
 * drives the meter under the mic and the stop-when-you-stop-talking timer.
 */

export type MicSupport = 'ok' | 'insecure' | 'unsupported';

/** Whether this page can record at all, and why not. */
export function micSupport(): MicSupport {
	if (typeof window === 'undefined') return 'unsupported';
	// getUserMedia only exists in a secure context: https, or localhost. A
	// phone opening http://192.168.x.x:3086 lands here, not in a permission
	// prompt, so it gets its own message.
	if (!window.isSecureContext) return 'insecure';
	if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return 'unsupported';
	return 'ok';
}

/** The first container this browser records to: opus everywhere but Safari. */
function pickMime(): string {
	for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) {
		if (MediaRecorder.isTypeSupported?.(m)) return m;
	}
	return '';
}

export interface Recording {
	blob: Blob;
	mime: string;
	ms: number;
}

export class Recorder {
	private stream: MediaStream | null = null;
	private rec: MediaRecorder | null = null;
	private ctx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private buf: Float32Array<ArrayBuffer> | null = null;
	private chunks: Blob[] = [];
	private startedAt = 0;

	get active(): boolean {
		return this.rec !== null;
	}

	/**
	 * Ask for the mic and start recording. Throws the browser's error (NotAllowedError…).
	 *
	 * The browser's own voice processing (noise suppression, AGC, echo
	 * cancellation) is OFF unless `browserProcessing` is set. Measured on a mic
	 * that is already denoised upstream (DeepFilterNet in a PipeWire chain):
	 * Brave's processing put the voice at −66 dBFS where the same mic without
	 * it read −40 — 26 dB eaten, and whisper heard "Subtítulos… de la Iglesia
	 * de Jesucristo" instead of "hola, qué tal". Speech recognition copes with
	 * room noise far better than with a voice chewed by a noise suppressor, and
	 * echo cancellation has nothing to cancel: Kernl stops talking when you
	 * start.
	 */
	async start(opts: { browserProcessing?: boolean } = {}): Promise<void> {
		if (this.rec) return;
		const on = opts.browserProcessing === true;
		this.stream = await navigator.mediaDevices.getUserMedia({
			// Mono: some setups (a PipeWire filter chain) deliver the voice on the
			// left channel only, and a stereo recording mixed down later loses 6 dB.
			audio: { echoCancellation: on, noiseSuppression: on, autoGainControl: on, channelCount: 1 },
		});
		const mime = pickMime();
		// 32 kbps opus is plenty for speech (whisper resamples to 16 kHz anyway);
		// the browser default (~128 kbps) made a 45 s message cross nginx's 1 MB.
		this.rec = new MediaRecorder(this.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32_000 });
		this.chunks = [];
		this.rec.ondataavailable = (e) => {
			if (e.data.size > 0) this.chunks.push(e.data);
		};
		this.rec.start();
		this.startedAt = performance.now();
		try {
			this.ctx = new AudioContext();
			const src = this.ctx.createMediaStreamSource(this.stream);
			this.analyser = this.ctx.createAnalyser();
			this.analyser.fftSize = 1024;
			src.connect(this.analyser);
			this.buf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
		} catch {
			// No meter, no auto-stop; recording itself still works.
			this.analyser = null;
		}
	}

	/** Current input level in dBFS (−100 when there is no meter). */
	levelDb(): number {
		if (!this.analyser || !this.buf) return -100;
		this.analyser.getFloatTimeDomainData(this.buf);
		let sum = 0;
		for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
		const rms = Math.sqrt(sum / this.buf.length);
		return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
	}

	/** Whether `levelDb()` means anything here. */
	get metered(): boolean {
		return this.analyser !== null;
	}

	/** Milliseconds since recording started. */
	get elapsedMs(): number {
		return this.rec ? performance.now() - this.startedAt : 0;
	}

	/** Stop and hand back what was said. */
	stop(): Promise<Recording> {
		const rec = this.rec;
		if (!rec) return Promise.reject(new Error('not recording'));
		return new Promise((resolve) => {
			rec.onstop = () => {
				const mime = rec.mimeType || 'audio/webm';
				const out = { blob: new Blob(this.chunks, { type: mime }), mime, ms: performance.now() - this.startedAt };
				this.release();
				resolve(out);
			};
			rec.stop();
		});
	}

	/** Drop the recording and free the mic. */
	cancel(): void {
		if (this.rec && this.rec.state !== 'inactive') {
			this.rec.onstop = null;
			this.rec.stop();
		}
		this.release();
	}

	private release(): void {
		this.ctx?.close().catch(() => {});
		this.ctx = null;
		this.analyser = null;
		this.buf = null;
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = null;
		this.rec = null;
		this.chunks = [];
	}
}

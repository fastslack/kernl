/// <reference lib="dom" />
// Browser module living in the kernel repo: the kernel's own tsconfig is
// server-side and ships no DOM libs, so the requirement is declared here
// rather than widening the global config for everything else.

/**
 * Shared subtitle engine for extension players.
 *
 * Kernl grew three players — cinema, torrents and TV — and each re-implemented
 * the same machinery: list the caption tracks that exist, fetch one, render its
 * cues over the video, kick off transcription or translation, and follow the
 * job's progress. This module is that machinery, once.
 *
 * The shape is an ADAPTER, not a fixed API: every player names its own
 * endpoints and maps its own records onto `SubTrack`. That's what lets cinema
 * keep Nostr-federated subs, torrents keep per-file cached subs, and TV keep
 * language-per-programme, while sharing everything underneath.
 *
 * Three hard-won rules are encoded here so no player has to rediscover them:
 *
 *  1. A `<track src>` request carries no Authorization header. Always fetch the
 *     VTT through the host's authenticated fetch and install cues programmatically.
 *  2. Swapping cues on a live TextTrack does NOT refresh Chromium's native
 *     renderer. You must go showing → disabled → addCue → showing. (Torrents
 *     had this latent bug; installing cues here fixes it everywhere.)
 *  3. `textTrack.cues` is null while the track is disabled — never assume it's
 *     an array.
 */

// ── The vocabulary ───────────────────────────────────────────────

export interface SubTrack {
  /** Opaque, unique per track within a media item. */
  id: string;
  /** Human label — "en · original", "en → es", "Spanish". */
  label: string;
  /** BCP-47-ish language of the TEXT you'd see on screen. */
  lang: string;
  kind: "transcribe" | "translation" | "shipped" | "federated";
  /** Source language for a translation. */
  srcLang?: string;
  /** Epoch ms, when known — used for "3m ago". */
  createdAt?: number;
  /** Anything the host wants back in fetchVtt/remove. */
  raw?: unknown;
}

export interface SubsJobStatus {
  status: "idle" | "running" | "ready" | "error";
  /** 0..1 over the whole job. */
  progress: number;
  /** probe | extract | load-model | transcribe | translate | … */
  phase: string;
  hint: string;
  processedSec: number;
  totalSec: number;
  error: string;
  /** Cues translated so far / in total. Translation jobs only. */
  cuesDone?: number;
  cuesTotal?: number;
  /** Backend's own estimate of the time left, ms. Beats guessing from a %. */
  etaMs?: number;
  /** Where the work is happening, e.g. "llm" / "nllb", and "en → es". */
  engine?: string;
  route?: string;
}

export const IDLE_STATUS: SubsJobStatus = {
  status: "idle", progress: 0, phase: "", hint: "", processedSec: 0, totalSec: 0, error: "",
};

/** "1:18" / "45s" — time left, for a job that knows its own ETA. */
export function fmtEta(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * What a player must teach the controller about its own backend. Everything
 * except `listTracks` + `fetchVtt` is optional — a player that can't translate
 * simply doesn't provide `translate`, and the UI hides the control.
 */
export interface SubsAdapter {
  /** Every caption track available for the current media. */
  listTracks(): Promise<SubTrack[]>;
  /** The VTT body for one track. */
  fetchVtt(track: SubTrack): Promise<string>;
  /** Start transcription. Resolves once the job EXISTS, not when it finishes. */
  generate?(opts: { lang?: string }): Promise<SubsJobStatus | void>;
  /** Start a translation into `to`, optionally on a specific model. */
  translate?(opts: { to: string; from?: string; model?: string }): Promise<SubsJobStatus | void>;
  /** Poll one snapshot of the running job. */
  status?(lang?: string): Promise<SubsJobStatus | null>;
  /** Push-based progress. Return an unsubscribe fn. Preferred over polling. */
  subscribeProgress?(onStatus: (s: SubsJobStatus) => void): () => void;
  /** Delete a cached track. */
  remove?(track: SubTrack): Promise<void>;
  /** Abort the running job. */
  cancel?(): Promise<void>;
  /** Languages offerable for translation. */
  languages?(): Promise<Array<{ code: string; name: string }>>;
  /** Models the operator has configured, for the translation picker. */
  models?(): Promise<Array<{ id: string; label: string; provider?: string; fast?: boolean }>>;
  /** Score every model on a real batch and rank them for this job. */
  benchmark?(): Promise<Array<{ model: string; provider?: string; score: number; latencyMs: number; note: string }>>;
  /** Which track should be shown automatically once tracks load. */
  preferred?: (tracks: SubTrack[]) => SubTrack | null;
}

export const PHASE_LABEL: Record<string, string> = {
  probe: "Reading the tape",
  extract: "Pulling audio",
  "load-model": "Loading the model",
  transcribe: "Transcribing",
  translate: "Translating",
  download: "Downloading",
};

export function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? (phase ? phase[0].toUpperCase() + phase.slice(1) : "Working");
}

/** "3m ago" / "just now" — for cached-track ages. */
export function relativeAge(epochMs: number | undefined, now = Date.now()): string {
  if (!epochMs) return "";
  const s = Math.floor((now - epochMs) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Cue rendering ────────────────────────────────────────────────

export interface Cue { start: number; end: number; text: string }

function timestampToSeconds(s: string): number {
  const parts = s.split(":");
  if (parts.length === 3) return +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
  return +parts[0] * 60 + parseFloat(parts[1]);
}

/** Parse WebVTT (or SRT-ish) into cues. Tolerant of CRLF and missing indices. */
export function parseVtt(raw: string): Cue[] {
  const out: Cue[] = [];
  const lines = raw.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].includes("-->")) i++;
  while (i < lines.length) {
    const m = lines[i].match(/(\d+(?::\d+){1,2}(?:[.,]\d+)?)\s*-->\s*(\d+(?::\d+){1,2}(?:[.,]\d+)?)/);
    if (!m) { i++; continue; }
    const start = timestampToSeconds(m[1].replace(",", "."));
    const end = timestampToSeconds(m[2].replace(",", "."));
    i++;
    const text: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") { text.push(lines[i]); i++; }
    if (text.length) out.push({ start, end, text: text.join("\n") });
    while (i < lines.length && lines[i].trim() === "") i++;
  }
  return out;
}

/**
 * Install cues on a programmatic TextTrack.
 *
 * The disable-before-swap dance is load-bearing: Chromium keeps rendering the
 * OLD cues if you replace them while the track is 'showing'. Going through
 * 'disabled' forces the renderer to re-read.
 */
export function installCues(
  video: HTMLVideoElement,
  track: TextTrack | null,
  cues: Cue[],
  lang: string,
  /**
   * "hidden" keeps `cuechange` firing while the browser paints nothing, so the
   * player can render the text itself and style it. "showing" hands rendering
   * to the browser (almost no CSS control). Kernl uses hidden.
   */
  mode: "hidden" | "showing" = "hidden",
): TextTrack {
  let t = track;
  const live = Array.from(video.textTracks);
  if (!t || !live.includes(t)) t = video.addTextTrack("subtitles", "auto", lang || "en");

  // cues is null while disabled — read it BEFORE flipping the mode.
  t.mode = "showing";
  while (t.cues && t.cues.length > 0) t.removeCue(t.cues[0]);
  t.mode = "disabled";
  for (const c of cues) {
    try { t.addCue(new VTTCue(c.start, c.end, c.text)); } catch { /* malformed cue */ }
  }
  t.mode = mode;
  return t;
}

/** Hide whatever is showing without destroying the track. */
export function clearCues(track: TextTrack | null): void {
  if (!track) return;
  track.mode = "hidden";
  while (track.cues && track.cues.length > 0) track.removeCue(track.cues[0]);
  track.mode = "disabled";
}

// ── The controller ───────────────────────────────────────────────

const POLL_MS = 1200;

/**
 * Owns caption state for ONE media item: which tracks exist, which is on
 * screen, and the running job. Create per media, `destroy()` when done.
 */
export class SubsController {
  tracks: SubTrack[] = [];
  activeId = "";
  showing = false;
  /** Text of the cue(s) on screen right now — the player paints this. */
  cueText = "";
  job: SubsJobStatus = { ...IDLE_STATUS };
  languages: Array<{ code: string; name: string }> = [];
  models: Array<{ id: string; label: string; provider?: string; fast?: boolean }> = [];
  /** Model the viewer picked for translation. Empty = let the server decide. */
  model = "";
  error = "";

  private video: HTMLVideoElement | null = null;
  private textTrack: TextTrack | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  /** A show() that arrived before the <video> existed. Replayed by setVideo. */
  private pending: SubTrack | null = null;
  /** The cues we parsed — we paint from THESE, not from the browser. */
  private cueList: Cue[] = [];
  private timeHandler: (() => void) | null = null;

  constructor(
    private readonly adapter: SubsAdapter,
    /** Called whenever anything the UI renders changed. */
    private readonly onChange: () => void,
  ) {}

  private changed(): void {
    if (!this.disposed) this.onChange();
  }

  /**
   * Hand over the <video>. Hosts should call this reactively, because Svelte
   * binds the element AFTER the reactive statement that creates the controller
   * — the first call is often null.
   */
  setVideo(el: HTMLVideoElement | null): void {
    const changedEl = el !== this.video;
    this.video = el;
    if (!el) return;
    // The track belonged to the previous element; start fresh on this one.
    if (changedEl) this.textTrack = null;
    const replay = this.pending ?? (this.activeId ? this.active : null);
    if (replay) {
      this.pending = null;
      void this.show(replay);
    }
  }

  get active(): SubTrack | null {
    return this.tracks.find((t) => t.id === this.activeId) ?? null;
  }

  get busy(): boolean {
    return this.job.status === "running";
  }

  /** Load tracks (and languages), auto-showing the preferred one. */
  async refresh(opts: { autoSelect?: boolean; lang?: string } = {}): Promise<void> {
    try {
      this.tracks = await this.adapter.listTracks();
    } catch {
      this.tracks = [];
    }
    if (this.adapter.languages) {
      try { this.languages = await this.adapter.languages(); } catch { /* optional */ }
    }
    if (this.adapter.models && this.models.length === 0) {
      try { this.models = await this.adapter.models(); } catch { /* optional */ }
    }

    // A job may already be running server-side — started from another tab, by
    // an agent, or before this page was reloaded. Background work that the UI
    // can't see is the same as no background work, so adopt it.
    if (this.adapter.status && !this.busy) {
      try {
        const s = await this.adapter.status(opts.lang);
        if (s && s.status === "running") {
          this.job = s;
          this.watch(opts.lang);
        }
      } catch { /* optional */ }
    }
    this.changed();

    if (opts.autoSelect !== false && !this.activeId && this.tracks.length > 0) {
      const pick = this.adapter.preferred?.(this.tracks) ?? this.tracks[0];
      if (pick) await this.show(pick);
    }
  }

  /** Put a track on screen. */
  async show(track: SubTrack): Promise<void> {
    // No <video> yet (the host binds it after the DOM updates): remember the
    // request and replay it from setVideo(). Marking the track active without
    // installing cues would light up the CC button while nothing appears.
    if (!this.video) { this.pending = track; return; }
    try {
      const vtt = await this.adapter.fetchVtt(track);
      const cues = parseVtt(vtt);
      if (cues.length === 0) return;
      this.textTrack = installCues(this.video, this.textTrack, cues, track.lang);
      this.cueList = cues;
      this.wireCueClock(this.video);
      this.activeId = track.id;
      this.showing = true;
      this.changed();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.changed();
    }
  }

  /**
   * Drive the caption text from the media clock and OUR parsed cues.
   *
   * Deliberately not `cuechange`/`activeCues`: that only fires when the browser
   * decides the active set changed, so cues installed AFTER a seek on a paused
   * element never surface — which is exactly the state a broadcast player is in
   * when you tune in. Reading `currentTime` ourselves is deterministic and
   * behaves identically paused, playing or seeking.
   */
  private wireCueClock(video: HTMLVideoElement): void {
    this.unwireCueClock();
    const paint = () => {
      const t = video.currentTime;
      const hits = this.cueList.filter((c) => t >= c.start && t < c.end);
      const text = hits.map((c) => c.text).join("\n");
      if (text !== this.cueText) { this.cueText = text; this.changed(); }
    };
    for (const ev of ["timeupdate", "seeked", "seeking", "loadedmetadata"]) {
      video.addEventListener(ev, paint);
    }
    this.timeHandler = paint;
    paint();
  }

  private unwireCueClock(): void {
    if (!this.timeHandler || !this.video) return;
    for (const ev of ["timeupdate", "seeked", "seeking", "loadedmetadata"]) {
      this.video.removeEventListener(ev, this.timeHandler);
    }
    this.timeHandler = null;
  }

  /**
   * Show a VTT the caller already has, without a round trip.
   *
   * The blocking pipelines (cinema's /media/subs, torrents' /subs) resolve WITH
   * the finished body, so re-fetching it just to display it would be silly —
   * and would race the cache write. Display state stays owned by the controller
   * either way, so the CC button and track list can't drift out of sync.
   */
  showVtt(vtt: string, opts: { lang?: string; id?: string; label?: string } = {}): void {
    if (!this.video) return;
    const cues = parseVtt(vtt);
    if (cues.length === 0) return;
    const lang = opts.lang || "en";
    this.textTrack = installCues(this.video, this.textTrack, cues, lang);
    this.cueList = cues;
    this.wireCueClock(this.video);
    this.activeId = opts.id ?? this.activeId ?? "";
    this.showing = true;
    this.changed();
  }

  /** Subtitles off — keeps the track around so toggling back is instant. */
  off(): void {
    clearCues(this.textTrack);
    this.unwireCueClock();
    this.cueList = [];
    this.cueText = "";
    this.activeId = "off";
    this.showing = false;
    this.changed();
  }

  toggle(): void {
    if (this.showing) { this.off(); return; }
    const t = this.tracks.find((x) => x.id !== "off") ?? null;
    if (t) void this.show(t);
  }

  // ── Jobs ───────────────────────────────────────────────────────

  private watch(lang?: string): void {
    this.stopWatching();
    // Push beats polling when the backend offers it.
    if (this.adapter.subscribeProgress) {
      this.unsubscribe = this.adapter.subscribeProgress((s) => {
        this.job = s;
        this.changed();
        if (s.status === "ready") void this.onJobDone();
        else if (s.status === "error") this.stopWatching();
      });
      return;
    }
    if (!this.adapter.status) return;
    this.poll = setInterval(async () => {
      try {
        const s = await this.adapter.status!(lang);
        if (!s) return;
        this.job = s;
        this.changed();
        if (s.status === "ready") await this.onJobDone();
        else if (s.status === "error") this.stopWatching();
      } catch { /* transient */ }
    }, POLL_MS);
  }

  private async onJobDone(): Promise<void> {
    this.stopWatching();
    const before = new Set(this.tracks.map((t) => t.id));
    await this.refresh({ autoSelect: false });
    // Show whatever the job just produced.
    const fresh = this.tracks.find((t) => !before.has(t.id));
    if (fresh) await this.show(fresh);
    else if (this.activeId && this.active) await this.show(this.active);
  }

  private stopWatching(): void {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
  }

  /**
   * Run a caption job, whichever shape the backend uses.
   *
   * Two backend styles exist in Kernl and this handles both:
   *   · TV posts a job and returns immediately; progress comes from polling
   *     `status`, and the run survives the page.
   *   · cinema/torrents hold ONE long request open that resolves with the
   *     finished VTT, streaming progress over SSE meanwhile.
   *
   * So we attach the progress watcher BEFORE awaiting the call — otherwise the
   * blocking style would show a frozen bar for the entire run.
   */
  private async runJob(
    call: () => Promise<SubsJobStatus | void>,
    seed: Partial<SubsJobStatus>,
    watchLang?: string,
  ): Promise<void> {
    this.error = "";
    this.job = { ...IDLE_STATUS, status: "running", ...seed };
    this.changed();

    // Only the streaming/blocking style needs the watcher attached up front —
    // its request doesn't resolve until the work is done. For the polling
    // style we must NOT poll yet: the stored row still holds the PREVIOUS
    // run's terminal status ('error' from a failed attempt, 'ready' from an
    // earlier one), and reading it would stop the watcher before the new job
    // has even been created. That's how a finished translation ended up
    // invisible in the UI.
    const streaming = Boolean(this.adapter.subscribeProgress);
    if (streaming) this.watch(watchLang);

    try {
      const s = await call();
      if (s) this.job = s;
      // A blocking backend resolving IS completion; a job-posting backend
      // returns 'running' and the watcher takes it from here.
      if (!s || s.status === "ready") await this.onJobDone();
      else if (!streaming) this.watch(watchLang);
      this.changed();
    } catch (e) {
      this.stopWatching();
      this.job = { ...IDLE_STATUS, status: "error", error: e instanceof Error ? e.message : String(e) };
      this.changed();
    }
  }

  /** Transcribe the audio. */
  async generate(lang = ""): Promise<void> {
    if (!this.adapter.generate) throw new Error("this player can't transcribe");
    await this.runJob(() => this.adapter.generate!({ lang }), {}, lang);
  }

  /** Ranked model trials from the last benchmark run. */
  trials: Array<{ model: string; provider?: string; score: number; latencyMs: number; note: string }> = [];
  benchmarking = false;

  /** Measure which model is best at this job, then surface the ranking. */
  async benchmark(): Promise<void> {
    if (!this.adapter.benchmark || this.benchmarking) return;
    this.benchmarking = true;
    this.error = "";
    this.changed();
    try {
      this.trials = await this.adapter.benchmark();
      // Adopting the winner is the whole point of measuring.
      const best = this.trials.find((t) => t.score > 0);
      if (best) this.model = best.model;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.benchmarking = false;
      this.changed();
    }
  }

  /** Pick the model future translations run on. */
  setModel(id: string): void {
    this.model = id;
    this.changed();
  }

  /** Translate into `to`, on the picked model when one is set. */
  async translate(to: string, from?: string, model?: string): Promise<void> {
    if (!this.adapter.translate) throw new Error("this player can't translate");
    const pick = model ?? this.model;
    await this.runJob(
      () => this.adapter.translate!({ to, from, model: pick || undefined }),
      { phase: "translate", hint: `${from ?? ""} → ${to}` },
      to,
    );
  }

  async cancel(): Promise<void> {
    this.stopWatching();
    try { await this.adapter.cancel?.(); } catch { /* best effort */ }
    this.job = { ...IDLE_STATUS };
    this.changed();
  }

  /** Delete a cached track, dropping it from screen if it was showing. */
  async remove(track: SubTrack): Promise<void> {
    if (!this.adapter.remove) return;
    try {
      await this.adapter.remove(track);
      if (this.activeId === track.id) this.off();
      await this.refresh({ autoSelect: false });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.changed();
    }
  }

  destroy(): void {
    this.disposed = true;
    this.stopWatching();
    this.unwireCueClock();
    this.cueList = [];
    this.cueText = "";
    clearCues(this.textTrack);
    this.textTrack = null;
    this.video = null;
  }
}

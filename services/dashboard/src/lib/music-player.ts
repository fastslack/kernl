/**
 * Global music player — singleton state + audio element control + WebAudio
 * spectrum analyser. Imported from anywhere in the dashboard so the player
 * survives route changes (the actual <audio> element lives in MusicPlayer.svelte
 * which is mounted in the root layout).
 *
 * Why a singleton store + module-level audio ref instead of stuffing the audio
 * element in a context: the user wants the player to keep playing while they
 * navigate other modules. SvelteKit unmounts route components on nav, so the
 * audio + analyser must live OUTSIDE any route. Stores + a module-level
 * controller satisfy that without prop-drilling.
 */

import { writable, derived, get, type Readable } from 'svelte/store';

// ── Types ──────────────────────────────────────────────────────────

export type FormatKind =
  | 'vinyl_78' | 'vinyl_lp' | 'netlabel' | 'live'
  | 'radio'    | 'audiobook' | 'audio';

export interface Track {
  name: string;
  title: string;
  track: number | null;
  format: string;
  size: number;
  length_seconds: number | null;
  url: string;
}

export interface Album {
  identifier: string;
  title: string;
  creator: string;
  year: number | null;
  description: string;
  language: string;
  subject: string[];
  collection: string[];
  format_kind: FormatKind;
  cover_url: string;
  tracks: Track[];
}

export type DisplayMode = 'hidden' | 'mini' | 'drawer' | 'fullscreen';
export type RepeatMode = 'off' | 'all' | 'one';

// ── Stores ─────────────────────────────────────────────────────────

export const album         = writable<Album | null>(null);
/** Playback queue — derived from album.tracks, then optionally shuffled. */
export const queue         = writable<Track[]>([]);
export const currentIndex  = writable<number>(0);
export const playing       = writable<boolean>(false);
export const currentTime   = writable<number>(0);
export const duration      = writable<number>(0);
export const buffered      = writable<number>(0);
export const volume        = writable<number>(loadNum('mtwk-music-vol', 0.85));
export const muted         = writable<boolean>(loadBool('mtwk-music-muted', false));
export const shuffleOn     = writable<boolean>(loadBool('mtwk-music-shuffle', false));
export const repeatMode    = writable<RepeatMode>(loadStr('mtwk-music-repeat', 'off') as RepeatMode);
export const playbackRate  = writable<number>(loadNum('mtwk-music-rate', 1));
export const displayMode   = writable<DisplayMode>('hidden');
export const errorMsg      = writable<string | null>(null);
/** Snapshot of the freq-bin array, refreshed by MusicPlayer's RAF loop. */
export const spectrum      = writable<Uint8Array>(new Uint8Array(64));
/** Wall-clock ms when the sleep timer should pause playback (or null). */
export const sleepTimerAt  = writable<number | null>(null);
/** In-memory recently-played stack — the freshest entry is at index 0. */
export const recent        = writable<Album[]>([]);

// Persist a few settings to localStorage on change.
volume.subscribe((v) => safeSet('mtwk-music-vol', String(v)));
muted.subscribe((v) => safeSet('mtwk-music-muted', String(v)));
shuffleOn.subscribe((v) => safeSet('mtwk-music-shuffle', String(v)));
repeatMode.subscribe((v) => safeSet('mtwk-music-repeat', v));
playbackRate.subscribe((v) => safeSet('mtwk-music-rate', String(v)));

// ── Derived helpers ────────────────────────────────────────────────

export const currentTrack: Readable<Track | null> = derived(
  [queue, currentIndex],
  ([$q, $i]) => $q[$i] ?? null,
);

export const progress: Readable<number> = derived(
  [currentTime, duration],
  ([$t, $d]) => ($d > 0 ? Math.min(1, $t / $d) : 0),
);

// ── Audio element + WebAudio plumbing ──────────────────────────────

let audioEl: HTMLAudioElement | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let sourceNode: MediaElementAudioSourceNode | null = null;
let rafId: number | null = null;
let sleepTimerHandle: ReturnType<typeof setTimeout> | null = null;

/** Called by MusicPlayer.svelte once on mount. */
export function bindAudio(el: HTMLAudioElement): void {
  audioEl = el;
  el.volume = clamp01(get(volume));
  el.muted = get(muted);
  el.playbackRate = get(playbackRate);
}

export function unbindAudio(): void {
  audioEl = null;
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = null;
}

/**
 * Attach the WebAudio analyser. Must be called from a user gesture (browser
 * autoplay policy) — we wire it on the first `play()` action. Idempotent.
 *
 * The analyser is in-line (audio → analyser → destination), so the spectrum
 * reflects exactly what the user hears. We don't disconnect across albums —
 * MediaElementAudioSourceNode is bound to the <audio> element for its
 * lifetime, and re-creating one would throw.
 */
function ensureAnalyser(): void {
  if (analyser || !audioEl) return;
  try {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    sourceNode = audioCtx.createMediaElementSource(audioEl);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;     // → 64 freq bins, smooth-but-cheap
    analyser.smoothingTimeConstant = 0.8;
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
    spectrum.set(new Uint8Array(analyser.frequencyBinCount));
    startSpectrumLoop();
  } catch (e) {
    // CORS or already-tapped: silently degrade — UI just won't react to
    // audio. Don't tear the player down over a visualization detail.
    console.warn('[music] spectrum analyser unavailable:', e);
  }
}

function startSpectrumLoop(): void {
  if (rafId != null) return;
  const buf = new Uint8Array(analyser?.frequencyBinCount ?? 64);
  const tick = (): void => {
    if (analyser && get(playing)) {
      analyser.getByteFrequencyData(buf);
      spectrum.set(new Uint8Array(buf));
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

// ── Actions ────────────────────────────────────────────────────────

/**
 * Replace the current album + queue with an already-materialized Album and
 * start playback at `startIndex`.
 *
 * Materializing the track list (fetching /api/music/details) is the
 * CALLER's job — the music extension page fetches details and hands the
 * result over the `kernl:music:play` bridge event (see $lib/music-bridge).
 * The shell player stays generic: playback, queue, bar. It knows nothing
 * about where albums come from.
 */
export async function playAlbumData(a: Album, startIndex = 0): Promise<void> {
  errorMsg.set(null);
  if (!a || !Array.isArray(a.tracks) || a.tracks.length === 0) {
    errorMsg.set('No streamable tracks in this item.');
    return;
  }

  album.set(a);
  const ordered = get(shuffleOn) ? shuffleArray(a.tracks) : a.tracks.slice();
  queue.set(ordered);
  currentIndex.set(Math.max(0, Math.min(startIndex, ordered.length - 1)));
  if (get(displayMode) === 'hidden') displayMode.set('drawer');

  // Prepend to recent stack (dedupe by identifier).
  recent.update((xs) => {
    const filtered = xs.filter((x) => x.identifier !== a.identifier);
    return [a, ...filtered].slice(0, 24);
  });

  // Audio src is bound reactively by the component; we just need to start.
  // Wait one tick so the new <audio src> binding lands before .play().
  await Promise.resolve();
  await play();
}

/** Try to start playback. Triggered by user gesture, so analyser can attach. */
export async function play(): Promise<void> {
  if (!audioEl) return;
  ensureAnalyser();
  try {
    if (audioCtx?.state === 'suspended') await audioCtx.resume();
    await audioEl.play();
  } catch (e) {
    // Autoplay denied; surface so the UI can show a "tap to play" state.
    errorMsg.set(e instanceof Error ? e.message : String(e));
  }
}

export function pause(): void {
  audioEl?.pause();
}

export function toggle(): void {
  if (!audioEl) return;
  if (audioEl.paused) void play();
  else pause();
}

export function next(): void {
  const q = get(queue);
  const idx = get(currentIndex);
  if (q.length === 0) return;
  if (get(repeatMode) === 'one') {
    seek(0);
    void play();
    return;
  }
  if (idx + 1 < q.length) currentIndex.set(idx + 1);
  else if (get(repeatMode) === 'all') currentIndex.set(0);
  else { pause(); return; }
  // The `currentTrack` derived store will swap the audio src; auto-play.
  setTimeout(() => void play(), 30);
}

export function prev(): void {
  if (!audioEl) return;
  // Standard player UX: rewind if >3s into the track, else go to previous.
  if (audioEl.currentTime > 3) { seek(0); return; }
  const idx = get(currentIndex);
  if (idx > 0) currentIndex.set(idx - 1);
  else seek(0);
  setTimeout(() => void play(), 30);
}

export function jumpTo(idx: number): void {
  const q = get(queue);
  if (idx < 0 || idx >= q.length) return;
  currentIndex.set(idx);
  setTimeout(() => void play(), 30);
}

export function seek(t: number): void {
  if (!audioEl) return;
  audioEl.currentTime = Math.max(0, t);
}

export function setVolume(v: number): void {
  const c = clamp01(v);
  volume.set(c);
  if (audioEl) audioEl.volume = c;
  if (c > 0 && get(muted)) toggleMute(false);
}

export function toggleMute(force?: boolean): void {
  const next = force != null ? force : !get(muted);
  muted.set(next);
  if (audioEl) audioEl.muted = next;
}

export function toggleShuffle(): void {
  const next = !get(shuffleOn);
  shuffleOn.set(next);
  const a = get(album);
  if (!a) return;
  // Reorder the queue, keeping the currently-playing track at index 0.
  const cur = get(currentTrack);
  if (next) {
    const rest = a.tracks.filter((t) => t.name !== cur?.name);
    const shuffled = shuffleArray(rest);
    const newQ = cur ? [cur, ...shuffled] : shuffled;
    queue.set(newQ);
    currentIndex.set(0);
  } else {
    queue.set(a.tracks.slice());
    if (cur) {
      const idx = a.tracks.findIndex((t) => t.name === cur.name);
      currentIndex.set(idx >= 0 ? idx : 0);
    }
  }
}

export function cycleRepeat(): void {
  const order: RepeatMode[] = ['off', 'all', 'one'];
  const cur = get(repeatMode);
  const idx = order.indexOf(cur);
  repeatMode.set(order[(idx + 1) % order.length]);
}

export function setSpeed(rate: number): void {
  const r = Math.max(0.5, Math.min(3, rate));
  playbackRate.set(r);
  if (audioEl) audioEl.playbackRate = r;
}

export function setDisplayMode(mode: DisplayMode): void {
  displayMode.set(mode);
}

export function closePlayer(): void {
  pause();
  album.set(null);
  queue.set([]);
  currentIndex.set(0);
  currentTime.set(0);
  duration.set(0);
  displayMode.set('hidden');
}

/**
 * Schedule a hard-pause N minutes from now. `null` cancels.
 * The remaining-time UI reads `sleepTimerAt` and computes the delta itself.
 */
export function setSleepTimer(minutes: number | null): void {
  if (sleepTimerHandle) clearTimeout(sleepTimerHandle);
  sleepTimerHandle = null;
  if (minutes == null || minutes <= 0) {
    sleepTimerAt.set(null);
    return;
  }
  const ends = Date.now() + minutes * 60_000;
  sleepTimerAt.set(ends);
  sleepTimerHandle = setTimeout(() => {
    pause();
    sleepTimerAt.set(null);
    sleepTimerHandle = null;
  }, minutes * 60_000);
}

/**
 * Server-side play heartbeat. Throttled — call freely; the server-bumped
 * play_count + last_played_at update at most once per ~30s per track.
 */
let lastReport = 0;
export function reportPlay(opts: { force?: boolean } = {}): void {
  const now = Date.now();
  if (!opts.force && now - lastReport < 30_000) return;
  lastReport = now;
  const a = get(album);
  const t = get(currentTrack);
  if (!a || !t) return;
  void fetch('/api/music/play', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: a.identifier,
      track_name: t.name,
      seconds: Math.round(get(currentTime)),
      position: get(currentTime),
    }),
  }).catch(() => { /* fire-and-forget */ });
}

// ── Internals ──────────────────────────────────────────────────────

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function loadStr(key: string, fallback: string): string {
  if (typeof localStorage === 'undefined') return fallback;
  return localStorage.getItem(key) ?? fallback;
}
function loadNum(key: string, fallback: number): number {
  const s = loadStr(key, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}
function loadBool(key: string, fallback: boolean): boolean {
  const s = loadStr(key, '');
  return s === 'true' ? true : s === 'false' ? false : fallback;
}
function safeSet(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(key, value); } catch { /* quota / private mode */ }
}

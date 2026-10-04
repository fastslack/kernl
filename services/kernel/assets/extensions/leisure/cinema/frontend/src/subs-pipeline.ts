/**
 * Cinema's subtitle pipeline: finding, generating, translating and showing
 * captions for the film in the player.
 *
 * Lifted out of Page.svelte as one piece. The page still owns the player —
 * the film, its file list, the file playing and the <video> — and hands them
 * over as getters, so every read here sees the current value exactly as the
 * old in-component code did.
 *
 * State the page reads or reacts to lives in `cell`s: Svelte stores, so the
 * page subscribes with `$name` and its reactive blocks keep the same
 * per-variable dependencies they had, plus a synchronous `.v` for the
 * pipeline's own reads and writes. Everything the page never looks at stays
 * a plain local.
 */
import { tick } from 'svelte';
import { writable, type Writable } from 'svelte/store';
// Cue parsing, cue installation and caption styling are shared with /tv and
// /torrents — this page used to carry its own copies of all three.
import {
  parseVtt as parseVttShared, installCues,
  SubsController, type SubsAdapter, type SubTrack, type SubsJobStatus,
} from '$shared/media/subs-client';
import type { JsonApi } from '$shared/api';
import type { ArchiveItem, PlayFile } from './types.js';
import { archiveDownloadUrl, setDurationParam } from './media.js';

// ── Subtitle / translation state ───────────────────────────
interface SubLang { iso: string; name: string; }
interface SubChainLink { slug: string; provider: string; model: string; available: boolean; }
interface SubEngineInfo {
  engines: {
    nllb: { available: boolean; model: string; offline: boolean };
    llm:  { available: boolean; primary: SubChainLink; fallbacks: SubChainLink[] };
  };
  languages: SubLang[];
}

interface CachedSub {
  key: string;                 // sha1 hash → URL: /api/cinema/media/subs/file/<key>.vtt
  kind: 'transcribe' | 'translation' | 'shipped';
  src_lang: string;
  tgt_lang: string;
  engine?: string;             // whisper engine for transcribe; LLM engine for translation
  model?: string;
  cue_count?: number;
  created_at?: number;
}

interface FederatedSubRow {
  rowId: string;
  providerId: string;
  providerEventId: string;
  identifier: string;
  srcLang: string;
  tgtLang: string;
  engine: string;
  signerPubkey: string;
  webseedUrl: string;
  sha256: string;
  sizeBytes: number;
  content: string;
  observedAt: string;
  downloadedSubId: string | null;
}

interface TranscribeInfo {
  engines: {
    transformers: { available: boolean; model: string; offline: boolean; hint: string };
    whispercpp: { available: boolean; hint: string };
    groq: { available: boolean; model: string; hint: string };
  };
  models: string[];
}

export function shortPubkey(pk: string): string {
  if (!pk) return '—';
  return pk.slice(0, 8) + '…' + pk.slice(-4);
}

export function fmtBytesShort(n: number): string {
  if (!n) return '—';
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
  return `${n} B`;
}

/**
 * A writable the page can `$`-subscribe to, with a synchronous `.v` for the
 * pipeline's own reads and writes. `set` skips an unchanged primitive and
 * always notifies for objects, which is exactly how an assignment to a
 * component variable invalidated before.
 */
export type Cell<T> = Writable<T> & { v: T };

function cell<T>(init: T): Cell<T> {
  const { subscribe, set, update } = writable(init);
  let cur = init;
  subscribe((x) => { cur = x; });
  return {
    subscribe, set, update,
    get v() { return cur; },
    set v(x: T) { set(x); },
  };
}

/** What the pipeline needs from the page that owns the player. */
export interface SubsHost {
  /** Same-origin /api fetch with the host auth token attached. */
  apiFetch(input: string, init?: RequestInit): Promise<Response>;
  api: JsonApi;
  dbg(...args: unknown[]): void;
  item(): ArchiveItem | null;
  files(): PlayFile[];
  activeIdx(): number;
  video(): HTMLVideoElement | null;
}

export function createSubsPipeline(host: SubsHost) {
  const { apiFetch, api, dbg } = host;

  let subInfo: SubEngineInfo | null = null;

  // ── Subtitle UI state ──────────────────────────────────────────────
  // We keep two intent vars (`subSource`, `translateActive`) and derive
  // the internal `subTrack` value from them. That way the settings UI is
  // cleanly split into "where do subtitles come from?" and "do we
  // translate them?", but the URL-builder logic in `trackSrc()` keeps
  // its existing flat string vocabulary.
  type SubSource = 'off' | 'orig' | 'auto';
  const subSource = cell<SubSource>('off');
  const translateActive = cell(false);
  // Internal: the current subtitle "track" identifier the URL builder
  // understands. Computed reactively from (subSource, translateActive,
  // subTargetLang, subEngine). DO NOT set this directly from UI — set
  // subSource / translateActive instead.
  const subTrack = cell<string>('off');
  // Engine = which translation PATH to use. The actual provider/model
  // under "llm" is decided by the chain configured at /models (and may
  // fall back automatically on quota/auth errors). "nllb" stays as the
  // offline escape hatch.
  const subEngine = cell<'nllb' | 'llm'>('llm');
  // ── Apply gate ────────────────────────────────────────────────
  // The wizard now sets all params (source / target lang / engines)
  // up front and the user clicks ONE CTA at the bottom to run the
  // whole pipeline. `subsApplied` is the single gate — when false,
  // trackSrc() returns '' so no fetch fires; when true, the URL
  // builds from the current config and the loader takes it from
  // there. Reset whenever the video or the source mode changes
  // (the user has to confirm again for the new context).
  let subsApplied = false;
  // Explicit consent gate for WHISPER transcription. Opening a video must
  // NEVER auto-run whisper (a 141MB model download on first use + a full
  // CPU transcription of the film). trackSrc() only returns the generating
  // `/subs` pipeline URL when this is true, and it's set ONLY by an explicit
  // APPLY / generate click. Auto-open may still display subs that are ALREADY
  // materialized (cached VTT, shipped .srt) — those don't touch whisper.
  const generateRequested = cell(false);
  let advancedOpen = false;       // collapsed by default — keep UI minimal
  let generateOpen = false;       // legacy collapsible flag (unused after the
                                   // mode-based redesign — kept null-safe)
  // Two-mode design — the user only ever sees ONE simple screen at a
  // time. 'select' is the default: just a list of available subs + a
  // "+ Generate" button. 'generate' is a tiny config-and-run form that
  // takes over the panel. After Start, we auto-close the popover and
  // show progress via the centred modal.
  // (Legacy modalPhaseSwapTimer removed — the auto+translate flow now
  //  uses 2 sequential frontend fetches so the modal swap is exact.)
  let modalPhaseSwapTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Cached subs index ─────────────────────────────────────────────
  // List of subtitle files already produced for the current video URL.
  // Populated by GET /api/cinema/media/subs/list?url=… and refreshed after
  // every successful generation. Drives the "USE EXISTING" pill row.
  let cachedSubs: CachedSub[] = [];
  // The currently-applied sub identifier — drives the "selected" highlight
  // in the SELECT row. 'off' / 'shipped' / a CachedSub.key.
  let activeSubKey: string = 'off';

  // ── Federated subtitle marketplace (Stage 4b) ────────────────────
  // Mirrors the cinema_subs_index server-side. Each row is an
  // announcement seen on a discovery provider (Nostr, archive.org).
  // Click "bajar" → POST /api/cinema/subs/download → bytes land in the
  // legacy data/subtitles/ cache → refreshCachedSubs picks it up so the
  // user can activate it from the regular SELECT row.
  const federatedSubs = cell<FederatedSubRow[]>([]);
  const federatedRefreshing = cell(false);
  const federatedTrustOnly = cell(false);
  const federatedError = cell('');
  // Trust map keyed by signer pubkey (hex). Populated alongside the
  // federated rows. Values: mine | trusted | blocked | unknown.
  const publishersMap = cell<Record<string, { trust: string; alias: string }>>({});
  // Per-row download progress so we can disable the button while in
  // flight without needing a global busy flag.
  const downloadingRowIds = cell(new Set<string>());

  async function loadFederatedSubs(refresh = false): Promise<void> {
    if (!host.item()) return;
    federatedError.v = '';
    if (refresh) federatedRefreshing.v = true;
    try {
      const url = `/api/cinema/subs/by-video/${encodeURIComponent(host.item().identifier)}${refresh ? '?refresh=1' : ''}`;
      const body = await api.getJson(url);
      federatedSubs.v = Array.isArray(body?.federated) ? body.federated : [];
      publishersMap.v = body?.publishers ?? {};
      dbg('[cinema] loadFederatedSubs:', federatedSubs.v.length, 'rows', refresh ? '(refreshed)' : '(cached)');
    } catch (err: any) {
      federatedError.v = err?.message ?? String(err);
    } finally {
      federatedRefreshing.v = false;
    }
  }

  async function downloadFederated(row: FederatedSubRow): Promise<void> {
    if (downloadingRowIds.v.has(row.rowId)) return;
    downloadingRowIds.v = new Set(downloadingRowIds.v).add(row.rowId);
    try {
      const body = await api.postJson('/api/cinema/subs/download', { rowId: row.rowId });
      // Refresh both views so the new sub shows up in the regular cached
      // list AND the index marks the federated row as downloaded.
      await Promise.all([refreshCachedSubs(), loadFederatedSubs(false)]);
      // Auto-activate the freshly-downloaded sub via the existing path.
      if (body?.cache_key) {
        const cs = cachedSubs.find(c => c.key === body.cache_key);
        if (cs) selectCachedSub(cs);
      }
    } catch (err: any) {
      federatedError.v = err?.message ?? String(err);
    } finally {
      const next = new Set(downloadingRowIds.v);
      next.delete(row.rowId);
      downloadingRowIds.v = next;
    }
  }

  /**
   * Cinema's caption backend as a shared-module adapter.
   *
   * The gnarly part is fetchVtt: a "track" here can be one of three things and
   * each resolves differently. That logic is cinema-specific and stays here —
   * the adapter exists precisely so the shared controller never has to know.
   */
  const subsCtl = cell<SubsController | null>(null);
  const subsTick = cell(0);

  function cinemaAdapter(): SubsAdapter {
    return {
      async listTracks(): Promise<SubTrack[]> {
        if (!host.item() || !host.files()[host.activeIdx()]) return [];
        const upstream = archiveDownloadUrl(host.item().identifier, host.files()[host.activeIdx()].name);
        let fromBackend: CachedSub[] = [];
        try {
          const j = await api.getJson(`/api/cinema/media/subs/list?url=${encodeURIComponent(upstream)}`);
          fromBackend = (Array.isArray(j?.subs) ? j.subs : []) as CachedSub[];
        } catch { /* non-fatal */ }

        // Subtitle files shipped inside the archive item itself need no
        // transcribe at all — merge them in as synthetic entries.
        const shipped = detectShippedSubs(host.files()).map<CachedSub>((sh) => ({
          key: sh.key,
          kind: 'transcribe',
          src_lang: sh.lang || subSourceLang.v,
          tgt_lang: sh.lang || subSourceLang.v,
          engine: 'shipped',
          model: sh.file.name,
          cue_count: 0,
          created_at: 0,
        }));
        const merged: CachedSub[] = [...shipped];
        const have = new Set(merged.map((x) => x.key));
        for (const b of fromBackend) if (!have.has(b.key)) { merged.push(b); have.add(b.key); }

        return merged.map((cs) => ({
          id: cs.key,
          lang: cs.kind === 'translation' ? cs.tgt_lang : cs.src_lang,
          label: cs.kind === 'translation'
            ? `${cs.src_lang} → ${cs.tgt_lang}`
            : cs.engine === 'shipped'
              ? `${cs.src_lang} · incluido`
              : `${cs.src_lang} · original`,
          kind: cs.engine === 'shipped' ? 'shipped' : cs.kind,
          srcLang: cs.src_lang,
          createdAt: cs.created_at || undefined,
          raw: cs,
        }));
      },

      async fetchVtt(track): Promise<string> {
        const cs = track.raw as CachedSub;
        let fetchUrl: string;
        if (cs.key.startsWith('shipped:') && host.item()) {
          // The item ships its own .srt — just convert it, no model involved.
          const filename = cs.model || cs.key.slice('shipped:'.length);
          if (!filename) throw new Error('shipped sub without a filename');
          const upstream = `https://archive.org/download/${encodeURIComponent(host.item().identifier)}/${filename.split('/').map(encodeURIComponent).join('/')}`;
          const params = new URLSearchParams({
            url: upstream,
            src: cs.src_lang || subSourceLang.v,
            tgt: cs.src_lang || subSourceLang.v,
            passthrough: '1',
          });
          fetchUrl = `/api/cinema/media/translate-srt?${params.toString()}`;
        } else if (cs.key.startsWith('local:') && host.item() && host.files()[host.activeIdx()]) {
          // No backend sidecar — re-derive the pipeline URL from cached params.
          const file = host.files()[host.activeIdx()];
          const upstream = archiveDownloadUrl(host.item().identifier, file.name);
          const willTranslate = cs.kind === 'translation' && cs.tgt_lang !== cs.src_lang;
          const params = new URLSearchParams({
            url: upstream,
            lang: cs.src_lang,
            transcribe_engine: transcribeEngine.v,
            transcribe_model: cs.model || transcribeModel.v,
          });
          if (willTranslate) {
            params.set('tgt', cs.tgt_lang);
            params.set('translate_engine', cs.engine || subEngine.v);
          }
          setDurationParam(params, file);
          fetchUrl = `/api/cinema/media/subs?${params.toString()}`;
        } else {
          fetchUrl = `/api/cinema/media/subs/file?key=${cs.key}`;
        }

        const r = await apiFetch(fetchUrl);
        if (!r.ok) throw new Error(`sub fetch ${r.status}`);
        const vtt = await r.text();

        // Keep the wizard in step so the CC state and the pickers agree.
        translateActive.v = cs.kind === 'translation';
        if (cs.kind === 'translation') subTargetLang.v = cs.tgt_lang;
        subSourceLang.v = cs.src_lang;
        subsApplied = true;
        lastLoadedTrackUrl = fetchUrl;
        return vtt;
      },

      async remove(track) {
        const r = await apiFetch(`/api/cinema/media/subs/file?key=${encodeURIComponent(track.id)}`, {
          method: 'DELETE',
        });
        if (!r.ok) throw new Error(`delete ${r.status}`);
      },

      /**
       * Auto-pick on open. `local:` entries have no materialized VTT —
       * resolving one hits the pipeline, which can run whisper, so it must
       * never be chosen unprompted.
       */
      preferred: (tracks) =>
        tracks.find((t) => !t.id.startsWith('local:') && t.kind === 'translation' && t.lang === subTargetLang.v)
        ?? tracks.find((t) => !t.id.startsWith('local:') && t.kind !== 'translation')
        ?? null,

      /**
       * Generate captions for this film.
       *
       * The adapter used to stop at listTracks/fetchVtt/remove, because
       * generation was driven by a separate wizard of this page's own rather
       * than through the controller. With that wizard gone, the player's
       * "Generate subtitles" button called a method nobody had implemented —
       * so the one remaining path did nothing at all.
       *
       * It delegates to the same orchestrator the wizard used, so there is
       * one transcription pipeline and not a second copy of it.
       */
      async generate(opts) {
        if (!host.item() || !host.files()[host.activeIdx()]) {
          throw new Error('no hay un archivo de video seleccionado');
        }
        if (opts?.lang) subSourceLang.v = opts.lang;
        // Transcribe only. Translation is its own call below, so asking for
        // captions never silently also translates them.
        translateActive.v = false;
        generateRequested.v = true;
        await runAutoTranslatePipeline();
      },

      /** Translate the current captions into `to`, via the same pipeline. */
      async translate(opts) {
        if (!host.item() || !host.files()[host.activeIdx()]) {
          throw new Error('no hay un archivo de video seleccionado');
        }
        subTargetLang.v = opts.to;
        if (opts.from) subSourceLang.v = opts.from;
        translateActive.v = true;
        generateRequested.v = true;
        await runAutoTranslatePipeline();
      },

      /** Stop whatever is running. */
      async cancel() {
        if (inflightAbort) { try { inflightAbort.abort(); } catch { /* already gone */ } }
        // 'cancelled', not 'done' — a cancel produced nothing, so the
        // controller must not go looking for a finished track to show.
        stopProgress(undefined, 'cancelled');
      },

      /**
       * Push-based progress, which the controller prefers over polling. Cinema
       * already runs an SSE channel against the kernel for exactly this data;
       * this hands it to the player instead of keeping it to itself.
       */
      subscribeProgress(onStatus) {
        jobListeners.add(onStatus);
        // Seed only when something IS running. Emitting an idle snapshot here
        // would clear `ctl.job` the instant the controller starts watching,
        // blanking the UI until the first SSE event arrives.
        const seed = currentJobStatus();
        if (seed.status === 'running') onStatus(seed);
        return () => { jobListeners.delete(onStatus); };
      },

      /** What the kernel can translate into — the menu's language list. */
      async languages() {
        if (!subInfo) await loadSubInfo();
        return (subInfo?.languages ?? []).map((l) => ({ code: l.iso, name: l.name }));
      },
    };
  }

  /** Rebuild the controller for the current item + file, and load its tracks. */
  async function refreshCachedSubs(): Promise<void> {
    if (!host.item() || !host.files()[host.activeIdx()]) return;
    if (!subsCtl.v) {
      subsCtl.v = new SubsController(cinemaAdapter(), () => { subsTick.v++; });
    }
    if (host.video()) subsCtl.v.setVideo(host.video());
    // autoSelect only when nothing is on screen yet — never yank a sub the
    // viewer explicitly chose.
    await subsCtl.v.refresh({ autoSelect: !subsApplied });
    subsTick.v++;
  }

  async function applySubs() {
    dbg('[cinema] applySubs: confirmed', { subSource: subSource.v, translateActive: translateActive.v, subTargetLang: subTargetLang.v, subEngine: subEngine.v, transcribeEngine: transcribeEngine.v, transcribeModel: transcribeModel.v });
    // Auto-pick path: if the LLM chain (configured at /models) has any
    // usable link, use it; otherwise fall back to offline NLLB. Provider
    // selection inside "llm" is the chain's job — quota/auth fallbacks
    // happen there transparently.
    if (translateActive.v && subTargetLang.v !== subSourceLang.v && !advancedOpen) {
      subEngine.v = subInfo?.engines.llm.available ? 'llm' : 'nllb';
      console.log(`[cinema] auto-picked engine: ${subEngine.v}`);
    }
    const willTranslate = translateActive.v && subTargetLang.v !== subSourceLang.v;
    subsApplied = true;
    // Explicit user consent to run whisper (this is the only place that sets
    // it). trackSrc() gates the generating /subs pipeline on this flag, so
    // opening a video never auto-downloads the model.
    if (subSource.v === 'auto') generateRequested.v = true;
    // The user wants the video paused at 0:00 while we generate, then
    // auto-resumed once captions are loaded. Otherwise they'd waste
    // minutes of the film while staring at a "Transcribing…" modal,
    // and miss the cues for the parts that already played.
    pauseAndRewindForGeneration();
    if (subSource.v === 'auto' && willTranslate && host.item() && host.files()[host.activeIdx()]) {
      await runAutoTranslatePipeline();
      return;
    }
    // Other paths: single call via trackSrc → loadTranscriptManual.
    if (subSource.v === 'auto') startProgress('transcribe');
    else if (willTranslate) startProgress('translate');
    await tick();
    dbg('[cinema] applySubs: triggering maybeLoadTranscript');
    maybeLoadTranscript();
  }

  // Whether we paused-and-rewound the video for an in-flight generation.
  // The post-load auto-resume only fires when this is true so we don't
  // restart playback on cache hits (where the user never even noticed).
  let resumeAfterSubs = false;
  function pauseAndRewindForGeneration(): void {
    if (!host.video()) { resumeAfterSubs = false; return; }
    const wasPlaying = !host.video().paused && !host.video().ended;
    // "Hasn't started yet" (paused at 0) counts as want-to-play — the
    // user opened the player, presumably to watch. Otherwise respect
    // intentional mid-film pause.
    const neverStarted = host.video().paused && host.video().currentTime < 0.5;
    try {
      host.video().pause();
      host.video().currentTime = 0;
    } catch { /* */ }
    resumeAfterSubs = wasPlaying || neverStarted;
    dbg('[cinema] pauseAndRewindForGeneration:', { wasPlaying, neverStarted, resume: resumeAfterSubs });
  }
  function resumePlaybackIfArmed(): void {
    if (!host.video() || !resumeAfterSubs) return;
    resumeAfterSubs = false;
    // Slight delay so the cuechange fires for cue 0 before play starts.
    setTimeout(() => {
      if (host.video()) host.video().play().catch(() => { /* user gesture may be required */ });
    }, 80);
  }

  // Two-phase orchestrator for auto-generate + translate. Runs
  // /transcribe (modal: "Transcribing audio…") then /translate-srt
  // pointing at the cached transcribe output (modal swaps to
  // "Translating to X…"). Installs cues at the end. Each phase has
  // its own modal state so the visual swap matches reality.
  /**
   * Turn a proxy's status code into something that names the actual problem.
   *
   * These codes never come from the kernel — it answers `{error}` JSON. A bare
   * 502 or 504 with an HTML body is nginx (or a dev-server proxy) reporting on
   * the kernel's behalf, and "transcribe http 502" told the user nothing about
   * which of the two very different situations they were in.
   */
  function transcribeHttpHint(status: number): string {
    if (status === 502 || status === 503) {
      return 'el kernel no respondió (502) — se está reiniciando o se cayó';
    }
    if (status === 504) {
      return 'el proxy cortó la espera (504) antes de que el kernel contestara';
    }
    return `transcribe http ${status}`;
  }

  /**
   * Follow a transcription run to its end.
   *
   * Polls rather than holding a socket, so the run is decoupled from any one
   * request. Transport failures are NOT terminal here on purpose: a restarting
   * kernel answers 502 for a few seconds, and the whole point of putting the
   * job in the database was that it is still there afterwards. Only a run that
   * reports a terminal state, or a stretch of silence long enough that nothing
   * is plausibly coming back, ends the wait.
   *
   * Returns null when the user aborted.
   */
  async function awaitTranscribeJob(
    key: string,
    signal: AbortSignal,
  ): Promise<{ status: string; error?: string; cueCount?: number } | null> {
    const POLL_MS = 2000;
    // ~2 minutes of consecutive unreachable polls. A kernel restart is ten
    // seconds; anything past this is not coming back on its own.
    const MAX_CONSECUTIVE_FAILURES = 60;
    let failures = 0;

    while (!signal.aborted) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (signal.aborted) return null;
      try {
        const r = await apiFetch(
          `/api/cinema/media/transcribe/status?key=${encodeURIComponent(key)}`,
          { credentials: 'omit', signal },
        );
        if (!r.ok) {
          // 404 means the row is gone and no cache file exists — for a job we
          // just started that is a restart that lost it before the first
          // write, which the next boot will have marked interrupted anyway.
          failures += 1;
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            return { status: 'error', error: transcribeHttpHint(r.status) };
          }
          continue;
        }
        failures = 0;
        const s = await r.json();
        if (s?.status === 'ready' || s?.status === 'error' || s?.status === 'interrupted') {
          return s;
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') return null;
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          return { status: 'error', error: `no se pudo consultar el trabajo: ${err?.message ?? String(err)}` };
        }
      }
    }
    return null;
  }

  /**
   * A transcript in `lang` we ALREADY have materialized on disk.
   *
   * The controller's track list is the truth here, not the cache key the
   * pipeline would compute. `/transcribe/start` short-circuits only on an
   * exact (url, engine, model, lang) match, and `transcribeEngine` /
   * `transcribeModel` are re-picked per session by loadSubInfo() — groq when
   * a key is configured, whispercpp otherwise. So a film whose menu already
   * showed "en · original" got its audio pulled and whisper re-run from
   * scratch the moment the engine that produced it wasn't the engine this
   * session would choose. Asking the list instead of the key skips whisper
   * whenever ANY usable transcript exists, whoever made it.
   *
   * Only sha1-keyed tracks qualify: `shipped:` is handled by its own branch
   * and `local:` entries are synthetic placeholders with no bytes behind them.
   */
  function cachedTranscriptKey(lang: string): string {
    const hit = (subsCtl.v?.tracks ?? []).find((t) =>
      t.kind === 'transcribe'
      && /^[a-f0-9]{40}$/i.test(t.id)
      && (t.srcLang || t.lang) === lang,
    );
    return hit?.id ?? '';
  }

  async function runAutoTranslatePipeline(): Promise<void> {
    const item = host.item(); const file = host.files()[host.activeIdx()];
    if (!item || !file) return;
    const upstream = archiveDownloadUrl(item.identifier, file.name);
    if (inflightAbort) { try { inflightAbort.abort(); } catch { /* */ } }
    inflightAbort = new AbortController();
    const myAbort = inflightAbort;
    // Block the reactive maybeLoadTranscript from racing us by claiming
    // the URL it would compute. trackSrc() returns the unified /subs
    // URL for this config — match it so the dedup skips during our run.
    const blockerUrl = trackSrc();
    if (blockerUrl) { inflightTrackUrl = blockerUrl; }

    // ── Phase 1: get the source-language transcript ────────────────
    // Three ways, cheapest first, and only the last one touches whisper:
    //   1. the archive item ships its own .srt (best text, seconds not minutes)
    //   2. we already transcribed this file at some point (bytes on disk)
    //   3. run whisper
    // All three end with `transcribedVtt` populated and `phase1UpstreamUrl`
    // pointing at the URL Phase 2's translate-srt should fetch as input.
    const shipped = detectShippedSubs(host.files());
    const shippedSrc = shipped.find((s) => s.lang === subSourceLang.v)
      ?? shipped.find((s) => s.lang === '');
    const cachedKey = shippedSrc ? '' : cachedTranscriptKey(subSourceLang.v);
    let transcribedVtt: string;
    let phase1UpstreamUrl: string;
    startProgress('transcribe');
    if (cachedKey) {
      dbg('[cinema] runAutoTranslatePipeline: reusing cached transcript', cachedKey);
      // Absolute, because translate-srt fetches this itself server-side (it
      // rewrites loopback /api/ hits to the kernel's internal port).
      phase1UpstreamUrl = `${window.location.origin}/api/cinema/media/subs/file?key=${cachedKey}`;
      try {
        const r = await apiFetch(
          `/api/cinema/media/subs/file?key=${encodeURIComponent(cachedKey)}`,
          { signal: myAbort.signal },
        );
        if (!r.ok) {
          const e = await r.json().catch(() => ({} as any));
          stopProgress(e.error ?? `cached transcript http ${r.status}`);
          return;
        }
        transcribedVtt = await r.text();
        transcribeAvailable.v = true;
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        stopProgress(`no se pudo leer el transcript en cache: ${err?.message ?? String(err)}`);
        return;
      }
    } else if (shippedSrc) {
      dbg('[cinema] runAutoTranslatePipeline: using shipped sub instead of whisper:', shippedSrc.file.name);
      const shippedUpstream = `https://archive.org/download/${encodeURIComponent(item.identifier)}/${shippedSrc.file.name.split('/').map(encodeURIComponent).join('/')}`;
      phase1UpstreamUrl = shippedUpstream;
      const shippedParams = new URLSearchParams({
        url: shippedUpstream, src: subSourceLang.v, tgt: subSourceLang.v, passthrough: '1',
      });
      try {
        const r = await apiFetch(`/api/cinema/media/translate-srt?${shippedParams.toString()}`, {
          credentials: 'omit', signal: myAbort.signal,
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({} as any));
          stopProgress(e.error ?? `shipped sub fetch http ${r.status}`);
          return;
        }
        transcribedVtt = await r.text();
        transcribeAvailable.v = true;
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        stopProgress(`shipped sub fetch failed: ${err?.message ?? String(err)}`);
        return;
      }
    } else {
      const transcribeParams = new URLSearchParams({
        url: upstream, engine: transcribeEngine.v, model: transcribeModel.v, lang: subSourceLang.v,
      });
      // startProgress('transcribe') opened the SSE — forward its jobId so
      // the kernel pushes whisper.cpp's per-percent progress to the bar.
      if (subsJobId) transcribeParams.set('jobId', subsJobId);
      setDurationParam(transcribeParams, host.files()[host.activeIdx()]);
      // For Phase 2, translate-srt will fetch the cached transcribe via
      // the kernel's own URL (handled by its localhost-rewrite logic). By
      // then the run has finished, so this route answers from cache instead
      // of holding anything open.
      const transcribeRoute = `/api/cinema/media/transcribe?${transcribeParams.toString()}`;
      phase1UpstreamUrl = `${window.location.origin}${transcribeRoute}`;
      try {
        // Start the run and let go of the request. Captioning a feature is
        // ten to fifteen minutes; holding one fetch open for that long meant
        // a proxy read timeout, a reload, or a kernel restart all landed as
        // an unexplained gateway error AND threw the work away. Now the run
        // is server-side state we can poll, reconnect to, and describe.
        const started = await apiFetch(
          `/api/cinema/media/transcribe/start?${transcribeParams.toString()}`,
          { credentials: 'omit', signal: myAbort.signal },
        );
        if (!started.ok) {
          const e = await started.json().catch(() => ({} as any));
          stopProgress(e.error ?? transcribeHttpHint(started.status));
          return;
        }
        const job = await started.json();
        const jobKey: string = job?.key ?? '';
        if (!jobKey) { stopProgress('el kernel no devolvió una clave de trabajo'); return; }

        const settled = await awaitTranscribeJob(jobKey, myAbort.signal);
        if (!settled) return;                     // aborted by the user
        if (settled.status === 'interrupted') {
          stopProgress('la transcripción se cortó porque el kernel se reinició — reintentá');
          return;
        }
        if (settled.status !== 'ready') {
          stopProgress(settled.error || `la transcripción terminó en ${settled.status}`);
          return;
        }
        transcribeCueCount.v = settled.cueCount ?? 0;

        const vttRes = await apiFetch(
          `/api/cinema/media/subs/file?key=${encodeURIComponent(jobKey)}`,
          { credentials: 'omit', signal: myAbort.signal },
        );
        if (!vttRes.ok) {
          const e = await vttRes.json().catch(() => ({} as any));
          stopProgress(e.error ?? `no se pudo leer el VTT generado (http ${vttRes.status})`);
          return;
        }
        transcribedVtt = await vttRes.text();
        transcribeAvailable.v = true;
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        stopProgress(`transcribe failed: ${err?.message ?? String(err)}`);
        return;
      }
    }

    // Transcription was the whole job — `generate()` comes through here with
    // translateActive false, and `subTargetLang` defaults to 'es', so running
    // Phase 2 unconditionally silently translated captions nobody asked to
    // have translated. Install what Phase 1 produced and stop.
    if (!translateActive.v || subTargetLang.v === subSourceLang.v) {
      if (inflightAbort === myAbort) inflightAbort = null;
      stopProgress();
      installVttCues(transcribedVtt);
      if (blockerUrl) { lastLoadedTrackUrl = blockerUrl; }
      inflightTrackUrl = '';
      await refreshCachedSubs();
      ensureCurrentSubInCacheList();
      resumePlaybackIfArmed();
      return;
    }

    // Phase 2: translate. Same regardless of how Phase 1 got its transcript
    // — the translate-srt endpoint just needs an upstream URL it can fetch.
    stopProgress(undefined, 'phase-swap');
    startProgress('translate');
    const translateParams = new URLSearchParams({
      url: phase1UpstreamUrl,
      src: subSourceLang.v,
      tgt: subTargetLang.v,
      engine: subEngine.v,
    });
    // startProgress('translate') opens the SSE channel; forward its jobId
    // so the kernel publishes batch progress onto it.
    if (subsJobId) translateParams.set('jobId', subsJobId);
    const translateUrl = `/api/cinema/media/translate-srt?${translateParams.toString()}`;
    // (Same: keep blockerUrl active for dedup; don't replace it.)
    let finalVtt: string;
    try {
      const r = await apiFetch(translateUrl, { credentials: 'omit', signal: myAbort.signal });
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        stopProgress(e.error ?? `translate http ${r.status}`);
        return;
      }
      finalVtt = await r.text();
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      stopProgress(`translate failed: ${err?.message ?? String(err)}`);
      return;
    } finally {
      if (inflightAbort === myAbort) inflightAbort = null;
      // The dedup blocker is cleared at the very end (see below) once
      // cues are installed. Don't clear here — would let a racing
      // reactive re-fetch the same data.
    }

    // Install cues. Done — clear progress and refresh the cached subs
    // list (so the new translation appears in the SELECT row).
    stopProgress();
    installVttCues(finalVtt);
    // Mark the trackSrc URL as loaded so the reactive doesn't refetch.
    if (blockerUrl) { lastLoadedTrackUrl = blockerUrl; }
    inflightTrackUrl = '';
    // installVttCues already called ensureCurrentSubInCacheList which
    // adds a synthetic entry if the backend doesn't list this sub.
    // refreshCachedSubs runs after for backend-truth updates.
    await refreshCachedSubs();
    ensureCurrentSubInCacheList();
    // Cues are installed → resume from 0:00 with subs visible.
    resumePlaybackIfArmed();
  }

  /**
   * Put a cached sub on screen. The three-way URL resolution lives in the
   * adapter now; this only guards the auto-open case.
   */
  async function selectCachedSub(cs: CachedSub, auto = false): Promise<void> {
    // `local:` has no materialized VTT — resolving it can run whisper, which
    // must never happen unprompted on open.
    if (auto && cs.key.startsWith('local:') && !generateRequested.v) {
      activeSubKey = 'off';
      return;
    }
    if (!subsCtl.v) await refreshCachedSubs();
    const track = subsCtl.v?.tracks.find((t) => t.id === cs.key);
    if (track) await subsCtl.v?.show(track);
    subsTick.v++;
  }

  /**
   * Display a VTT the pipelines already produced. Goes through the shared
   * controller so the track list, the CC state and what's on screen can't
   * drift apart — they used to be three separate sources of truth.
   */
  function installVttCues(rawVtt: string): void {
    if (!host.video()) return;
    if (!subsCtl.v) subsCtl.v = new SubsController(cinemaAdapter(), () => { subsTick.v++; });
    subsCtl.v.setVideo(host.video());
    subsCtl.v.showVtt(rawVtt, { lang: subSourceLang.v || 'en' });
    subsTick.v++;
    // The backend list may not report a just-generated sub yet — keep the
    // synthetic fallback so the viewer can still toggle it.
    ensureCurrentSubInCacheList();
  }

  // Push a synthetic entry to cachedSubs if there's no real match.
  // The synthetic key is deterministic per (kind, src, tgt, engine) so
  // re-runs don't duplicate. selectCachedSub uses the saved
  // trackSrc-derived URL — but for synthetic entries we re-derive at
  // click time from current state.
  function ensureCurrentSubInCacheList(): void {
    const willTranslate = translateActive.v && subTargetLang.v !== subSourceLang.v;
    const kind: 'translation' | 'transcribe' = willTranslate ? 'translation' : 'transcribe';
    const tgt = willTranslate ? subTargetLang.v : subSourceLang.v;
    const eng = willTranslate ? subEngine.v : transcribeEngine.v;
    const syntheticKey = `local:${kind}:${subSourceLang.v}:${tgt}:${eng}:${transcribeModel.v}`;
    const exists = cachedSubs.some(c =>
      c.kind === kind && c.src_lang === subSourceLang.v && c.tgt_lang === tgt && c.engine === eng
    );
    if (exists) {
      // Real entry already there — make sure it's the active one.
      const m = cachedSubs.find(c =>
        c.kind === kind && c.src_lang === subSourceLang.v && c.tgt_lang === tgt && c.engine === eng
      );
      if (m) activeSubKey = m.key;
      return;
    }
    cachedSubs = [...cachedSubs, {
      key: syntheticKey,
      kind,
      src_lang: subSourceLang.v,
      tgt_lang: tgt,
      engine: eng,
      model: transcribeModel.v,
      cue_count: manualTrack?.cues?.length ?? 0,
      created_at: Date.now(),
    }];
    activeSubKey = syntheticKey;
    dbg('[cinema] ensureCurrentSubInCacheList: synthetic entry added', syntheticKey);
  }
  // (Reset of `subsApplied` is handled explicitly in openPlayer(),
  // selectPlayFile(), closePlayer(), and the source-pill click handlers
  // — a reactive `$: subsApplied = false` block was racing the cache-hit
  // logic in openPlayer() and clobbering subsApplied=true after it was
  // legitimately set.)
  const subTargetLang = cell<string>('es');
  const subSourceLang = cell<string>('en');

  async function loadSubInfo() {
    if (subInfo) return;
    try {
      subInfo = await api.getJson('/api/cinema/media/translate-srt/info');
      // Pick a sane default engine based on what's actually available.
      // Order: lmstudio > ollama > grok > nllb. If user later opens
      // Advanced and picks a different one, that takes precedence.
      subEngine.v = subInfo?.engines.llm.available ? 'llm' : 'nllb';
      dbg('[cinema] loadSubInfo: default engine →', subEngine.v,
        subInfo?.engines.llm.available ? `(primary=${subInfo.engines.llm.primary.slug})` : '');
    } catch { /* keep null */ }
  }

  // ── Transcribe (auto-generate SRT from video) ──────────────────────
  let transcribeInfo: TranscribeInfo | null = null;
  const transcribeBusy = cell(false);
  let transcribeError = '';
  // ISO of the engine actually used to generate this run, for the track label.
  const transcribeAvailable = cell(false);
  const transcribeEngine = cell<'whispercpp' | 'transformers' | 'groq'>('whispercpp');
  const transcribeModel = cell<'tiny' | 'base' | 'small' | 'medium' | 'large-v3'>('base');
  // Live elapsed counter while whisper runs. The kernel doesn't ship a
  // streaming progress event for transcribe, so we just animate elapsed-vs-eta
  // — better than a frozen "generating…" label that makes users abandon.
  let transcribeStartedAt = 0;
  let transcribeElapsedMs = 0;
  let transcribeTimer: ReturnType<typeof setInterval> | null = null;
  // Just-finished flash for completion feedback (auto-clears).
  const transcribeJustDone = cell(false);
  const transcribeCueCount = cell(0);
  async function loadTranscribeInfo() {
    if (transcribeInfo) return;
    try {
      transcribeInfo = await api.getJson('/api/cinema/media/transcribe/info');
      if (transcribeInfo?.engines.groq.available) transcribeEngine.v = 'groq';
      else if (transcribeInfo?.engines.whispercpp.available) transcribeEngine.v = 'whispercpp';
      else transcribeEngine.v = 'transformers';
    } catch { /* */ }
  }

  // Build the URL for the auto-generated VTT track (same shape as
  // translate-srt; cached on the kernel by the same hashing scheme).
  function transcribeUrl(): string {
    if (!host.item() || !host.files()[host.activeIdx()]) return '';
    const file = host.files()[host.activeIdx()];
    const upstream = archiveDownloadUrl(host.item().identifier, file.name);
    const params = new URLSearchParams({ url: upstream, engine: transcribeEngine.v, model: transcribeModel.v });
    if (subSourceLang.v) params.set('lang', subSourceLang.v);
    if (subsJobId) params.set('jobId', subsJobId);
    setDurationParam(params, file);
    return `/api/cinema/media/transcribe?${params.toString()}`;
  }

  // AbortController for the in-flight whisper fetch, exposed so the
  // overlay's Cancel button can interrupt a runaway job.
  let transcribeAbort: AbortController | null = null;
  // Hard ceiling so a stuck whisper run doesn't pin the overlay
  // forever. 25 min covers a feature film on whisper.cpp · base; bigger
  // models or transformers engine may need more.
  const TRANSCRIBE_HARD_TIMEOUT_MS = 25 * 60 * 1000;

  /**
   * Tear the subtitle pipeline down to a clean slate: abort whatever is in
   * flight, kill the timers, close the SSE channel and clear the busy flags.
   *
   * This has to run whenever the player leaves a video, not only when the
   * user cancels. Nothing used to: closing the modal or opening another film
   * left `translateBusy` stuck at true and `subsJobId` pointing at the
   * previous run's channel. The consequences compounded —
   *
   *   • the progress card rendered on the NEXT film reading "TRANSLATING 0%",
   *     for a translation that was not running;
   *   • `startProgress()` is idempotent on `translateBusy`, so it returned
   *     early and never armed a real run;
   *   • `loadTranscriptManual()` is gated on `!translateBusy`, so the lazy
   *     modal never armed either;
   *   • and the request carried the dead jobId, publishing progress to a
   *     channel with no subscriber left.
   *
   * Net effect: translate once, and every film after it showed a permanent
   * fake "loading" and could never be translated again for the life of the
   * tab. One teardown, called from every exit, is the whole fix.
   */
  function resetSubsPipeline(): void {
    // Abort BOTH the legacy generateSubs() path AND the unified-flow
    // loadTranscriptManual() fetch — whichever is running has to stop.
    if (transcribeAbort) {
      try { transcribeAbort.abort(); } catch { /* already gone */ }
      transcribeAbort = null;
    }
    if (inflightAbort) {
      try { inflightAbort.abort(); } catch { /* already gone */ }
      inflightAbort = null;
      inflightTrackUrl = '';
    }
    transcribeBusy.v = false;
    translateBusy.v = false;
    if (transcribeTimer) { clearInterval(transcribeTimer); transcribeTimer = null; }
    if (translateTimer) { clearInterval(translateTimer); translateTimer = null; }
    if (modalPhaseSwapTimer) { clearTimeout(modalPhaseSwapTimer); modalPhaseSwapTimer = null; }
    stopSubsProgressStream();          // closes the EventSource AND clears subsJobId
    failedTrackUrls = new Set();       // a new video gets a clean slate
    translateCuesDone = 0;
    translateCuesTotal = 0;
    translateEtaMs = 0;
    translateElapsedMs = 0;
    transcribeElapsedMs = 0;
    translateError.v = '';
  }

  function cancelGenerateSubs(): void {
    dbg('[cinema] cancelGenerateSubs: user cancelled');
    resetSubsPipeline();
    transcribeError = 'Cancelled by user.';
    subsApplied = false;          // user cancelled — let them re-configure
  }

  async function generateSubs() {
    if (transcribeBusy.v || !host.item() || !host.files()[host.activeIdx()]) return;
    dbg('[cinema] generateSubs: starting whisper', transcribeEngine.v, transcribeModel.v);
    transcribeBusy.v = true;
    transcribeError = '';
    transcribeStartedAt = Date.now();
    transcribeElapsedMs = 0;
    // Open the SSE so the bar tracks whisper.cpp's per-percent progress.
    // Must happen BEFORE transcribeUrl() is called so the jobId lands in
    // the request query.
    if (!subsJobId) startSubsProgressStream();
    if (transcribeTimer) clearInterval(transcribeTimer);
    transcribeTimer = setInterval(() => {
      transcribeElapsedMs = Date.now() - transcribeStartedAt;
    }, 250);
    transcribeAbort = new AbortController();
    const timeoutHandle = setTimeout(() => {
      console.warn('[cinema] generateSubs: hard timeout after', TRANSCRIBE_HARD_TIMEOUT_MS, 'ms');
      try { transcribeAbort?.abort(); } catch { /* */ }
      transcribeError = `Whisper timed out after ${Math.round(TRANSCRIBE_HARD_TIMEOUT_MS / 60000)} min — try a smaller model or a faster engine.`;
    }, TRANSCRIBE_HARD_TIMEOUT_MS);

    try {
      const r = await apiFetch(transcribeUrl(), {
        method: 'GET',
        signal: transcribeAbort.signal,
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        transcribeError = e.error ?? `http ${r.status}`;
        console.warn('[cinema] generateSubs: kernel returned', r.status, transcribeError);
        return;
      }
      const cueHdr = r.headers.get('x-transcribe-cues');
      transcribeCueCount.v = cueHdr ? parseInt(cueHdr, 10) : 0;
      await r.text();           // drain so the cache file lands on disk
      dbg('[cinema] generateSubs: success', transcribeCueCount.v, 'cues in', Date.now() - transcribeStartedAt, 'ms');
      transcribeAvailable.v = true;
      subSource.v = 'auto';
      transcribeJustDone.v = true;
      setTimeout(() => { transcribeJustDone.v = false; }, 4500);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        dbg('[cinema] generateSubs: aborted (cancel or timeout)');
        // transcribeError already set by the cancel/timeout path
      } else {
        transcribeError = err?.message ?? String(err);
        console.warn('[cinema] generateSubs: failed', transcribeError);
      }
    } finally {
      clearTimeout(timeoutHandle);
      transcribeAbort = null;
      transcribeBusy.v = false;
      if (transcribeTimer) { clearInterval(transcribeTimer); transcribeTimer = null; }
      stopSubsProgressStream();
      dbg('[cinema] generateSubs: finally → transcribeBusy=false');
    }
  }

  function fmtElapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60), ss = s % 60;
    return m > 0 ? `${m}:${String(ss).padStart(2, '0')}` : `${ss}s`;
  }

  // Probe the kernel for a cached VTT for the (url, engine, model, lang)
  // combo currently selected. Sets `transcribeAvailable` so the UI swaps
  // the "generate" button for the "auto" toggle without an extra click.
  // Also stashes whether ANY engine/model has produced a cache for this
  // URL — lets us hint "we have one with whisper.cpp/base, switch?".
  let transcribeCacheAny = false;     // true if some combo is cached
  async function probeTranscribeCache(): Promise<void> {
    if (!host.item() || !host.files()[host.activeIdx()]) {
      transcribeAvailable.v = false;
      transcribeCacheAny = false;
      return;
    }
    const file = host.files()[host.activeIdx()];
    const upstream = archiveDownloadUrl(host.item().identifier, file.name);
    const params = new URLSearchParams({ url: upstream, engine: transcribeEngine.v, model: transcribeModel.v });
    if (subSourceLang.v) params.set('lang', subSourceLang.v);
    try {
      const data = await api.getJson<{ exact: boolean; any: boolean; key: string }>(
        `/api/cinema/media/transcribe/cached?${params.toString()}`);
      transcribeAvailable.v = data.exact;
      transcribeCacheAny = data.any;
    } catch { /* ignore — keep the generate button visible */ }
  }
  // Programmatic VTT loader — Svelte's `{#if trackUrl} <track>` inside
  // `<video>` doesn't always register the track on the media element
  // (the if-block comment markers confuse the browser). We fetch the VTT
  // ourselves, parse it, and feed cues into a TextTrack created via
  // `addTextTrack()`. Same end-result, no <track> element needed.
  let manualTrack: TextTrack | null = null;
  let activeCueText = '';           // current cue(s) the overlay paints
  let lastLoadedTrackUrl = '';
  /** Track URLs that failed permanently — never re-request them for this video. */
  let failedTrackUrls = new Set<string>();
  let inflightTrackUrl = '';      // dedupe: which URL is being fetched right now
  let inflightAbort: AbortController | null = null;  // cancel old fetch on new one

  // Translate-in-progress UX. The kernel's `/api/cinema/media/translate-srt`
  // endpoint is synchronous and can take 4–5 min on NLLB (CPU). Without a
  // visible status the user thinks the click did nothing.
  const translateBusy = cell(false);
  let translateStartedAt = 0;
  let translateElapsedMs = 0;
  let translateTimer: ReturnType<typeof setInterval> | null = null;
  const translateError = cell('');
  const translateMode = cell<'transcribe' | 'translate'>('translate');

  // Real-time subs-pipeline progress fed by the kernel via SSE
  // (`/api/cinema/media/subs/progress?jobId=…`). Covers BOTH phases —
  // transcribe (`frac` from whisper.cpp's per-percent stdout) and
  // translate (`cuesDone/cuesTotal` per-batch). When real data is
  // available the bar tracks it instead of the wall-clock estimate.
  let subsJobId = '';
  let translateCuesDone = 0;
  let translateCuesTotal = 0;
  let translateEtaMs = 0;       // 0 = no kernel data yet (fall back to estimate)
  let transcribeFrac = 0;       // 0–1 from kernel; 0 = no kernel data
  // Sub-phase tracking — populated by the kernel's `transcribe-progress`
  // event so the modal can show "Downloading model… (40 MB)" vs
  // "Transcribing… 47% (2m18s of 5m23s)". When `transcribeSubPhase` is
  // empty the bar runs in indeterminate mode (animated stripes, no %).
  let transcribeSubPhase: '' | 'probe' | 'load-model' | 'extract' | 'transcribe' = '';
  let transcribeProcessedSec = 0;
  let transcribeTotalSec = 0;
  let transcribeHint = '';
  let subsSse: EventSource | null = null;

  function startSubsProgressStream(): string {
    if (subsSse) { try { subsSse.close(); } catch { /* */ } subsSse = null; }
    translateCuesDone = 0;
    translateCuesTotal = 0;
    translateEtaMs = 0;
    transcribeFrac = 0;
    transcribeSubPhase = '';
    transcribeProcessedSec = 0;
    transcribeTotalSec = 0;
    transcribeHint = '';
    const jobId = crypto.randomUUID();
    subsJobId = jobId;
    const token = (typeof window !== 'undefined' ? localStorage.getItem('kernel_auth_token') : null) ?? '';
    // EventSource can't set headers — the kernel accepts the auth token as
    // a `?auth=` query parameter (src/core/auth.ts).
    const authPart = token ? `&auth=${encodeURIComponent(token)}` : '';
    const sseUrl = `/api/cinema/media/subs/progress?jobId=${encodeURIComponent(jobId)}${authPart}`;
    try {
      subsSse = new EventSource(sseUrl);
      subsSse.onmessage = (ev) => {
        if (!ev.data) return;
        try {
          const d = JSON.parse(ev.data) as
            // transcribe phase
            | { phase: 'transcribe-start'; engine?: string; model?: string; lang?: string }
            | {
                phase: 'transcribe-progress';
                frac?: number;
                subPhase?: 'probe' | 'load-model' | 'extract' | 'transcribe';
                processedSec?: number;
                totalSec?: number;
                hint?: string;
              }
            | { phase: 'transcribe-done'; cueCount?: number; elapsedMs?: number }
            | { phase: 'transcribe-error'; error?: string }
            // translate phase
            | { phase: 'start'; cuesTotal?: number }
            | { phase: 'progress'; cuesDone?: number; cuesTotal?: number; etaMs?: number; elapsedMs?: number }
            | { phase: 'done' }
            | { phase: 'error'; error?: string };
          if (d.phase === 'transcribe-start') {
            transcribeFrac = 0;
            transcribeSubPhase = '';
            transcribeProcessedSec = 0;
            transcribeTotalSec = 0;
            transcribeHint = '';
          } else if (d.phase === 'transcribe-progress') {
            if (typeof d.frac === 'number') transcribeFrac = Math.max(0, Math.min(1, d.frac));
            if (d.subPhase) transcribeSubPhase = d.subPhase;
            if (typeof d.processedSec === 'number') transcribeProcessedSec = d.processedSec;
            if (typeof d.totalSec === 'number') transcribeTotalSec = d.totalSec;
            if (typeof d.hint === 'string') transcribeHint = d.hint;
          } else if (d.phase === 'transcribe-done') {
            transcribeFrac = 1;
            transcribeSubPhase = 'transcribe';
            if (typeof d.cueCount === 'number') transcribeCueCount.v = d.cueCount;
          } else if (d.phase === 'start') {
            translateCuesTotal = d.cuesTotal ?? 0;
            translateCuesDone = 0;
          } else if (d.phase === 'progress') {
            if (typeof d.cuesTotal === 'number') translateCuesTotal = d.cuesTotal;
            if (typeof d.cuesDone === 'number') translateCuesDone = d.cuesDone;
            if (typeof d.etaMs === 'number') translateEtaMs = d.etaMs;
          }
          // 'done' / 'error' are surfaced through the HTTP response of the
          // pipeline fetch itself; we just keep the SSE open until then.
          publishJobStatus();
        } catch { /* ignore malformed event */ }
      };
      subsSse.onerror = () => {
        // EventSource auto-reconnects; nothing to do.
      };
    } catch { /* SSE not supported / blocked — fall through, bar uses estimate */ }
    return jobId;
  }

  function stopSubsProgressStream(): void {
    if (subsSse) { try { subsSse.close(); } catch { /* */ } subsSse = null; }
    subsJobId = '';
  }

  // ── Job status → the shared controller ─────────────────────────────
  //
  // The SSE above is the only live source of truth about a running subtitle
  // job. It used to write into cinema's own locals and nowhere else, so the
  // shared player's two surfaces — the chip in the bar and the progress block
  // in the caption menu — read a `ctl.job` nobody ever fed and sat at 0% for
  // the entire run, while cinema's own modal showed real cue counts beside
  // them. Three reports of one job, two of them wrong.
  //
  // `subscribeProgress` is the adapter hook the controller already prefers
  // over polling. Feeding it here makes the player the single owner of what
  // the user sees, and let cinema's duplicate modal go.
  let jobListeners = new Set<(s: SubsJobStatus) => void>();

  /** Build the current status from whatever the SSE has told us so far. */
  function currentJobStatus(): SubsJobStatus {
    const translating = translateBusy.v && translateMode.v === 'translate';
    const progress = translating
      ? (translateCuesTotal > 0 ? translateCuesDone / translateCuesTotal : 0)
      : transcribeFrac;
    return {
      status: (translateBusy.v || transcribeBusy.v) ? 'running' : 'idle',
      progress: Math.max(0, Math.min(1, progress)),
      phase: translating ? 'translate' : (transcribeSubPhase || 'transcribe'),
      hint: translating ? '' : transcribeHint,
      processedSec: transcribeProcessedSec,
      totalSec: transcribeTotalSec,
      error: '',
      cuesDone: translating ? translateCuesDone : undefined,
      cuesTotal: translating && translateCuesTotal > 0 ? translateCuesTotal : undefined,
      etaMs: translating && translateEtaMs > 0 ? translateEtaMs : undefined,
      engine: translating ? subEngine.v : transcribeEngine.v,
      route: translating ? `${subSourceLang.v} → ${subTargetLang.v}` : subSourceLang.v,
    };
  }

  function publishJobStatus(): void {
    const s = currentJobStatus();
    for (const fn of jobListeners) {
      try { fn(s); } catch { /* a listener must not break the stream */ }
    }
  }

  function startProgress(mode: 'transcribe' | 'translate'): void {
    // Idempotent: if the same mode is already running, don't reset the
    // elapsed counter (applySubs() and the lazy timer in
    // loadTranscriptManual() may both trigger it for the same fetch).
    if (mode === 'transcribe' && transcribeBusy.v) return;
    if (mode === 'translate' && translateBusy.v) return;
    translateMode.v = mode;
    translateError.v = '';
    if (mode === 'transcribe') {
      // Route to the BIG centered transcribe-overlay modal (with spinner,
      // ETA bar, Cancel) — this is the "modal bonito" the user expects to
      // see whenever whisper is running, regardless of whether it was
      // triggered by the legacy generateSubs() path or the unified
      // applySubs() → loadTranscriptManual() pipeline.
      transcribeBusy.v = true;
      transcribeError = '';
      transcribeStartedAt = Date.now();
      transcribeElapsedMs = 0;
      if (transcribeTimer) clearInterval(transcribeTimer);
      transcribeTimer = setInterval(() => {
        transcribeElapsedMs = Date.now() - transcribeStartedAt;
      }, 250);
    } else {
      // Smaller corner translate-card — translation can run in parallel
      // with the user already watching the original-lang subs.
      translateBusy.v = true;
      translateStartedAt = Date.now();
      translateElapsedMs = 0;
      if (translateTimer) clearInterval(translateTimer);
      translateTimer = setInterval(() => {
        translateElapsedMs = Date.now() - translateStartedAt;
      }, 250);
    }
    // Open the SSE channel ONCE per pipeline run — covers both transcribe
    // and translate phases, so a unified runAutoTranslatePipeline doesn't
    // need to re-open it on the phase swap (which would race the kernel's
    // first batch event). Reuse if it's already open.
    if (!subsJobId) startSubsProgressStream();
    publishJobStatus();   // the player's chip + menu light up immediately
  }
  /**
   * `outcome` says what actually happened, because this function is called
   * for three different things and the shared controller must not be told
   * the same story about all of them:
   *   'done'       — the run finished (or failed, if `err` is set)
   *   'cancelled'  — the user stopped it; nothing was produced
   *   'phase-swap' — transcribe ended, translate is about to start. The job
   *                  is still running; the controller must not hear a word.
   */
  function stopProgress(err?: string, outcome: 'done' | 'cancelled' | 'phase-swap' = 'done'): void {
    // Clear both: a single pipeline run may have started transcribe first
    // and translate after, so we don't know which is currently active.
    translateBusy.v = false;
    transcribeBusy.v = false;
    if (translateTimer) { clearInterval(translateTimer); translateTimer = null; }
    if (transcribeTimer) { clearInterval(transcribeTimer); transcribeTimer = null; }
    if (modalPhaseSwapTimer) { clearTimeout(modalPhaseSwapTimer); modalPhaseSwapTimer = null; }
    stopSubsProgressStream();
    if (err) {
      // Surface the error in whichever card is/was showing.
      if (translateMode.v === 'transcribe') transcribeError = err;
      else translateError.v = err;
    }
    // A phase swap is NOT the end of the job, and saying it is broke the
    // translate button outright: the controller reacts to 'ready' by calling
    // onJobDone(), which unsubscribes us, refreshes the track list and shows
    // whatever it finds — and showing a track goes through the adapter's
    // load(), which aborts `inflightAbort`. That controller is the pipeline's
    // own AbortController, so phase 2 died on an AbortError the pipeline
    // swallows silently. Pressing Translate did nothing at all, with no error
    // anywhere. Only a real ending talks to the controller.
    if (outcome === 'phase-swap') return;
    const base = currentJobStatus();
    const terminal: SubsJobStatus =
      err ? { ...base, status: 'error', error: err }
      : outcome === 'cancelled' ? { ...base, status: 'idle' }
      : { ...base, status: 'ready', progress: 1 };
    for (const fn of jobListeners) {
      try { fn(terminal); } catch { /* a listener must not break teardown */ }
    }
  }

  function parseVttTimestamp(ts: string): number {
    const parts = ts.split(':');
    if (parts.length === 3) return +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
    return +parts[0] * 60 + parseFloat(parts[1]);
  }

  function parseVtt(raw: string): Array<{ start: number; end: number; text: string }> {
    const out: Array<{ start: number; end: number; text: string }> = [];
    const lines = raw.replace(/\r/g, '').split('\n');
    let i = 0;
    // Skip WEBVTT header + any NOTE blocks until first cue.
    while (i < lines.length && !lines[i].includes('-->')) i++;
    while (i < lines.length) {
      const m = lines[i].match(/(\d+(?::\d+){1,2}(?:\.\d+)?)\s*-->\s*(\d+(?::\d+){1,2}(?:\.\d+)?)/);
      if (!m) { i++; continue; }
      const start = parseVttTimestamp(m[1]);
      const end = parseVttTimestamp(m[2]);
      i++;
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        buf.push(lines[i]);
        i++;
      }
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        out.push({ start, end, text: buf.join('\n') });
      }
      while (i < lines.length && lines[i].trim() === '') i++;
    }
    return out;
  }

  // Trigger transcript load. Called from multiple places (reactive,
  // on:loadedmetadata, onPlayState) because Svelte's bind:this+$:
  // combination can miss the moment when `videoEl` finally has a value.
  function maybeLoadTranscript(): void {
    if (typeof window === 'undefined') return;
    // CRITICAL: compute the track URL fresh inside the function instead of
    // reading the `$: trackUrl` reactive var. Svelte's topological sort
    // is based on real reads (not `void`s), so `trackUrl` may be stale
    // when this reactive block fires earlier than the trackUrl one.
    const url = trackSrc();
    dbg('[cinema] maybeLoadTranscript', { hasVideo: !!host.video(), url, subTrack: subTrack.v, transcribeAvailable: transcribeAvailable.v, hasPlayItem: !!host.item(), filesLen: host.files().length, lastLoadedTrackUrl });
    if (!host.video()) { return; }
    if (!url) {
      // Only WIPE cues when the user explicitly turned subs OFF. trackSrc()
      // also returns '' for "auto, not yet generated" — in that state a
      // cached transcript may already be installed by selectCachedSub(), and
      // clearing it here would erase subs the user is watching.
      if (subSource.v === 'off') {
        if (manualTrack) {
          while (manualTrack.cues && manualTrack.cues.length > 0) {
            manualTrack.removeCue(manualTrack.cues[0]);
          }
        }
        activeCueText = '';
        lastLoadedTrackUrl = '';
      }
      return;
    }
    if (url === lastLoadedTrackUrl) { dbg('[cinema] maybeLoadTranscript: already loaded, skip'); return; }
    if (failedTrackUrls.has(url)) { dbg('[cinema] maybeLoadTranscript: known-bad url, skip'); return; }
    if (url === inflightTrackUrl) { dbg('[cinema] maybeLoadTranscript: in-flight, skip'); return; }
    void loadTranscriptManual(url);
  }
  async function loadTranscriptManual(url: string): Promise<void> {
    const v = host.video();
    if (!v) return;
    dbg('[cinema] fetching VTT:', url);
    // Cancel any prior in-flight fetch so we don't end up with two
    // overlapping requests competing to set translateBusy / call
    // stopProgress in the wrong order. The aborted call's catch handler
    // recognises AbortError and exits without touching state.
    if (inflightAbort) { try { inflightAbort.abort(); } catch { /* */ } }
    inflightAbort = new AbortController();
    const myAbort = inflightAbort;
    inflightTrackUrl = url;
    // Detect long-running kernel work: translate-srt is slow (NLLB CPU
    // inference) and transcribe (cache miss) is even slower. Show a
    // progress card during the wait so the user has feedback.
    // The unified `/api/cinema/media/subs` endpoint runs transcribe (always) +
    // translate (if `tgt` is set) inside a single kernel call — show the
    // big centered transcribe modal because that's the dominant cost.
    const isUnified = url.startsWith('/api/cinema/media/subs');
    // `passthrough=1` is the same endpoint doing no translation at all — it
    // just converts a shipped .srt to WebVTT, which the browser needs because
    // <track> cannot read SRT. Counting it as a translation is why opening
    // any film that ships subtitles raised a full "TRANSLATING TO ESPAÑOL ·
    // LLM · EN → ES" modal that nobody asked for: the request never touched
    // an LLM, only the URL prefix matched.
    const isPassthrough = /[?&]passthrough=1(?:&|$)/.test(url);
    const isTranslate = url.startsWith('/api/cinema/media/translate-srt') && !isPassthrough;
    const isTranscribe = url.startsWith('/api/cinema/media/transcribe') || isUnified;
    // Closure-scoped lazy timer for transcribe — previously stored on
    // globalThis, which the second concurrent call would overwrite,
    // leaking the first timer (it would fire later and stick the
    // "Loading transcript…" card on screen forever).
    let lazyTimer: ReturnType<typeof setTimeout> | null = null;
    // CRITICAL: applySubs() now starts progress optimistically AND may
    // schedule a transcribe→translate phase swap. Re-starting it from
    // here would race the swap timer and resurrect transcribe mode after
    // we already moved on, leaving BOTH the big modal AND the corner
    // card visible at once. Only engage if nothing's already showing.
    if ((isTranslate || isTranscribe) && !translateBusy.v && !transcribeBusy.v) {
      // Cache hits return in <100ms — only show progress if the response
      // genuinely delays beyond 1.5s. Re-check at fire time too.
      //
      // Translate used to open its modal eagerly, so a cached translation
      // flashed a full-screen "translating…" card on its way to being
      // instant. A real run takes minutes; 1.5s of nothing costs it nothing.
      const mode: 'translate' | 'transcribe' = isTranslate ? 'translate' : 'transcribe';
      lazyTimer = setTimeout(() => {
        if (!translateBusy.v && !transcribeBusy.v) startProgress(mode);
      }, 1500);
    }
    // Open SSE eagerly so jobId is ready to forward in the request below,
    // regardless of whether the modal overlay shows lazily. The kernel
    // publishes progress for /transcribe, /translate-srt, and /subs.
    if (!subsJobId && (isTranslate || isTranscribe)) {
      startSubsProgressStream();
    }
    let fetchUrl = url;
    if (subsJobId && (isTranslate || isTranscribe) && !fetchUrl.includes('jobId=')) {
      const sep = fetchUrl.includes('?') ? '&' : '?';
      fetchUrl = `${fetchUrl}${sep}jobId=${encodeURIComponent(subsJobId)}`;
    }
    let raw: string;
    try {
      const r = await apiFetch(fetchUrl, { credentials: 'omit', signal: myAbort.signal });
      if (lazyTimer) { clearTimeout(lazyTimer); lazyTimer = null; }
      if (!r.ok) {
        let msg = `http ${r.status}`;
        try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* fall through */ }
        const e = new Error(msg) as Error & { status?: number };
        e.status = r.status;
        throw e;
      }
      raw = await r.text();
    } catch (err) {
      // If we got aborted because a newer fetch superseded us, exit
      // silently — the new fetch's lifecycle owns the progress state.
      if (err instanceof Error && err.name === 'AbortError') {
        dbg('[cinema] VTT fetch aborted (superseded):', url.slice(-80));
        if (lazyTimer) clearTimeout(lazyTimer);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number })?.status;
      console.warn('[cinema] VTT fetch failed:', msg, status ? `(http ${status})` : '');
      // Some failures will never succeed on a retry: the shipped .srt has no
      // parseable cues (422), the URL is wrong (400/404), the extension is
      // gone (410). `lastLoadedTrackUrl` is only set on SUCCESS, so without
      // this the reactive re-fires the same doomed request forever — one
      // archive.org item with an empty .asr.srt produced a 422 on every
      // single update cycle. Transient codes (5xx, 429, network) stay
      // retryable on purpose.
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        failedTrackUrls.add(url);
      }
      if (lazyTimer) clearTimeout(lazyTimer);
      stopProgress(msg);
      if (inflightTrackUrl === url) inflightTrackUrl = '';
      if (inflightAbort === myAbort) inflightAbort = null;
      return;
    }
    stopProgress();
    if (inflightTrackUrl === url) inflightTrackUrl = '';
    if (inflightAbort === myAbort) inflightAbort = null;
    if (parseVttShared(raw).length === 0) {
      console.warn('[cinema] loadTranscriptManual: 0 cues — VTT may be malformed');
      return;
    }
    lastLoadedTrackUrl = url;
    // One owner for display: hand the body to the shared controller instead of
    // driving a second TextTrack from here.
    if (!subsCtl.v) subsCtl.v = new SubsController(cinemaAdapter(), () => { subsTick.v++; });
    subsCtl.v.setVideo(v);
    subsCtl.v.showVtt(raw, { lang: subSourceLang.v || 'en' });
    subsTick.v++;
    refreshCachedSubs().then(() => ensureCurrentSubInCacheList());
    resumePlaybackIfArmed();          // auto-resume from 0:00 with subs ready
    // `manualTrack` is null since display moved to the shared controller —
    // every other reader here is guarded, this debug line was not, so it threw
    // `Cannot read properties of null (reading 'mode')` as the LAST statement
    // of the install. An unhandled rejection from a console.log, which also
    // propagated up through the controller's show() → onJobDone() path.
    console.log(`[cinema] manual track ready, cues=${parseVttShared(raw).length}`);
  }
  // The first .srt file in the playFiles list (archive.org typically ships
  // English subs only for these old films).
  /**
   * Is this listing entry a subtitle file with something in it?
   *
   * The two places that look for shipped subtitles — `findSrtFile` for the
   * reactive track URL and `detectShippedSubs` for the track list — used to
   * each decide for themselves, and fixing only one left the other still
   * offering `AboutBan1935.asr.srt`: an entry archive.org lists at size 0
   * because its speech-recognition pass produced nothing. Both go through
   * here now, so the rule has one definition.
   *
   * The floor sits above zero on purpose: one well-formed SRT cue is roughly
   * 40 bytes, so anything smaller is a stub rather than subtitles.
   */
  const MIN_SUB_BYTES = 32;

  function hasSubtitleContent(f: PlayFile): boolean {
    return (f.size ?? 0) >= MIN_SUB_BYTES;
  }

  function findSrtFile(files: PlayFile[]): PlayFile | null {
    return files.find(f => /\.srt$/i.test(f.name) && hasSubtitleContent(f)) ?? null;
  }
  function srtUpstreamUrl(item: ArchiveItem, srt: PlayFile): string {
    return archiveDownloadUrl(item.identifier, srt.name);
  }

  // ── Shipped-subtitle detection ────────────────────────────────────
  // archive.org items often ship one or more sub files alongside the
  // video (English.srt, movie.es.srt, foo.fr.vtt, subtitles.it.ass …).
  // We scan playFiles, derive the language from filename conventions,
  // and surface each as a synthetic cachedSub so the user can:
  //  (a) pick it directly from SELECT (instant — no whisper needed)
  //  (b) translate it to a different lang via /translate-srt (no whisper)
  // Recognized patterns (case-insensitive):
  //   foo.es.srt           → es
  //   foo-spanish.vtt      → es (matched against ISO+name table)
  //   spanish.srt          → es
  //   subtitulos.es.srt    → es
  //   foo.srt              → unknown (assumed = subSourceLang for fallback)
  interface ShippedSub { file: PlayFile; lang: string; key: string; }
  /**
   * A subtitle file has to be listed AND have something in it — see
   * `hasSubtitleContent`, which both finders share so they cannot drift.
   */
  function detectShippedSubs(files: PlayFile[]): ShippedSub[] {
    const subs: ShippedSub[] = [];
    for (const f of files) {
      if (!/\.(srt|vtt|ass|ssa|sub)$/i.test(f.name)) continue;
      if (!hasSubtitleContent(f)) continue;
      const lang = sniffLangFromFilename(f.name);
      subs.push({
        file: f,
        lang,
        key: `shipped:${f.name}`,
      });
    }
    return subs;
  }
  // Map common language names/aliases to ISO 639-1 codes. Covers the
  // patterns archive.org rippers use most often (English, English_US,
  // spanish, español, latin, dub-en, etc.).
  function sniffLangFromFilename(name: string): string {
    const stem = name.toLowerCase().replace(/\.(srt|vtt|ass|ssa|sub)$/i, '');
    // Pattern 1: extension-style code suffix `.xx`  (e.g. movie.es.srt)
    const m1 = stem.match(/\.([a-z]{2,3})(?:[._-]|$)/);
    if (m1 && ISO_LANGS.has(m1[1])) return m1[1];
    // Pattern 2: language NAME anywhere in the filename
    for (const [needle, iso] of LANG_ALIASES) {
      if (stem.includes(needle)) return iso;
    }
    return '';            // unknown — caller treats as source language
  }
  const ISO_LANGS = new Set([
    'en','es','pt','fr','de','it','ja','zh','ru','ko','ar','nl','sv','no','da','fi','pl','tr','el','he','hi','th','vi','id','cs','ro','hu','uk','bg',
  ]);
  const LANG_ALIASES: Array<[string, string]> = [
    ['english', 'en'], ['eng', 'en'], ['inglés', 'en'], ['ingles', 'en'],
    ['spanish', 'es'], ['español', 'es'], ['espanol', 'es'], ['castellano', 'es'], ['latino', 'es'], ['esp', 'es'],
    ['portuguese', 'pt'], ['português', 'pt'], ['portugues', 'pt'], ['brasileiro', 'pt'], ['ptbr', 'pt'], ['pt-br', 'pt'],
    ['french', 'fr'], ['français', 'fr'], ['francais', 'fr'],
    ['german', 'de'], ['deutsch', 'de'], ['aleman', 'de'], ['alemán', 'de'],
    ['italian', 'it'], ['italiano', 'it'],
    ['japanese', 'ja'], ['日本語', 'ja'],
    ['chinese', 'zh'], ['mandarin', 'zh'], ['中文', 'zh'],
    ['russian', 'ru'], ['русский', 'ru'],
    ['korean', 'ko'], ['한국어', 'ko'],
    ['arabic', 'ar'], ['عربي', 'ar'],
    ['dutch', 'nl'], ['nederlands', 'nl'],
    ['swedish', 'sv'], ['svenska', 'sv'],
    ['polish', 'pl'], ['polski', 'pl'],
    ['turkish', 'tr'], ['türkçe', 'tr'],
  ];
  // Build the URL the player should fetch for the currently-applied
  // subtitle config. Single source of truth — gated by `subsApplied`.
  // Routes through the unified /api/cinema/media/subs endpoint for the
  // auto-generate path so transcribe + translate happen in one kernel
  // call (with cache reuse), and through /translate-srt for the
  // shipped-.srt path (which already does what we need).
  function trackSrc(): string {
    if (!host.item() || subSource.v === 'off') return '';
    if (!subsApplied) return '';

    const file = host.files()[host.activeIdx()];
    if (!file) return '';
    const willTranslate = translateActive.v && subTargetLang.v !== subSourceLang.v;

    if (subSource.v === 'auto') {
      // The `/subs` pipeline RUNS WHISPER on cache-miss (model download +
      // full-film transcription). Only hit it after an explicit generate
      // click. On auto-open, a cached transcript is installed directly by
      // selectCachedSub(), so returning '' here just means "cues already in
      // place, don't fetch" — maybeLoadTranscript() won't clear them (it
      // only clears when subSource === 'off').
      if (!generateRequested.v) return '';
      // Unified pipeline: kernel handles transcribe + (optional) translate
      // with cache at every stage. Single round-trip from the browser.
      const upstream = archiveDownloadUrl(host.item().identifier, file.name);
      const params = new URLSearchParams({
        url: upstream,
        lang: subSourceLang.v,
        transcribe_engine: transcribeEngine.v,
        transcribe_model: transcribeModel.v,
      });
      if (willTranslate) {
        params.set('tgt', subTargetLang.v);
        params.set('translate_engine', subEngine.v);
      }
      setDurationParam(params, file);
      return `/api/cinema/media/subs?${params.toString()}`;
    }

    // subSource === 'orig' → shipped .srt, optionally translated.
    const srt = findSrtFile(host.files());
    if (!srt) return '';
    const upstream = srtUpstreamUrl(host.item(), srt);
    const params = new URLSearchParams({ url: upstream, src: subSourceLang.v });
    if (willTranslate) {
      params.set('tgt', subTargetLang.v);
      params.set('engine', subEngine.v);
    } else {
      params.set('passthrough', '1');
      params.set('tgt', subSourceLang.v);
    }
    return `/api/cinema/media/translate-srt?${params.toString()}`;
  }
  // ── Player lifecycle ──────────────────────────────────────────────
  // The subtitle half of openPlayer() / selectPlayFile() / closePlayer().
  // Each is called at the point the page used to run these lines inline.

  /** A new film: nothing is applied and nothing may run until asked. */
  function resetForOpen(): void {
    subSource.v = 'off';
    translateActive.v = false;
    subsApplied = false;              // require explicit APPLY click for this video
    generateRequested.v = false;      // new video → no whisper until an explicit APPLY
    transcribeAvailable.v = false;
    transcribeError = '';
    translateError.v = '';
    resetSubsPipeline();              // a run from the previous video must not leak into this one
  }

  /** Another file of the same film. */
  function resetForFile(): void {
    resetSubsPipeline();              // a run from the previous video must not leak into this one
    subsApplied = false;              // new file → user must reconfirm subs
    generateRequested.v = false;      // new file → no whisper until explicit APPLY
  }

  function resetOnClose(): void {
    activeSubKey = 'off';
    cachedSubs = [];
    resetSubsPipeline();              // closing mid-translation must not poison the next film
  }

  /** Once the file list is in: find captions this film already has and show them. */
  async function recoverOnOpen(): Promise<void> {
    // Probe the kernel for a cached transcript NOW, while we have the
    // active file URL in scope. The reactive `$: probeTranscribeCache()`
    // in Page.svelte also fires, but Svelte 4 sometimes elides `void x`
    // dependency tracking and the playFiles-mutation re-run gets dropped
    // — calling explicitly here makes the auto-show deterministic.
    dbg('[cinema] openPlayer: probing for cached transcript');
    await probeTranscribeCache();
    // Also load the full sidecar list so SELECT shows everything
    // already produced for this video.
    await refreshCachedSubs();
    // Cheap read of the federated index — Stage-4b marketplace.
    // Doesn't hit Nostr/archive.org; just SQLite. The user can ask
    // for a fresh sweep with the "search the network" button.
    await loadFederatedSubs(false);
    // ── Auto-recovery ────────────────────────────────────────────
    // refreshCachedSubs() above already merged THREE sources into
    // `cachedSubs`: shipped .srt files in the archive, transcribe/
    // translate VTTs cached on the kernel, and federated subs we
    // already downloaded. We pick the best one and INSTALL IT now via
    // selectCachedSub() — the cache-hit path returns in <100ms so it
    // looks instant. No modal, no whisper, no waiting.
    //
    // Priority (later wins, in this order): transcribe in source lang
    // (acceptable fallback) → shipped in source lang → cached
    // translation matching user's preferred target lang → most
    // recently created sub.
    //
    // We don't auto-download federated subs (network fetch + trust
    // implications) — the user opens the picker and clicks "bajar"
    // for those.
    const localHasSrt = host.files().some(f => /\.srt$/i.test(f.name));
    const preferredTgt = subTargetLang.v || subSourceLang.v;
    const pickAutoSub = (): CachedSub | null => {
      if (cachedSubs.length === 0) return null;
      // 1. Cached translation matching the user's preferred target lang.
      const matchTgt = cachedSubs.find(
        c => c.kind === 'translation' && c.tgt_lang === preferredTgt,
      );
      if (matchTgt) return matchTgt;
      // 2. Shipped sub in the source language.
      const shippedSrc = cachedSubs.find(
        c => c.kind === 'shipped' && (c.src_lang === subSourceLang.v || !c.src_lang),
      );
      if (shippedSrc) return shippedSrc;
      // 3. Cached transcribe in source lang.
      const transcribeSrc = cachedSubs.find(
        c => c.kind === 'transcribe' && c.src_lang === subSourceLang.v,
      );
      if (transcribeSrc) return transcribeSrc;
      // 4. Whatever's freshest (already sorted by refreshCachedSubs).
      return cachedSubs[0];
    };
    const auto = pickAutoSub();
    if (auto) {
      dbg('[cinema] openPlayer: auto-recovering', auto.kind, auto.tgt_lang || auto.src_lang, auto.key);
      generateOpen = false;
      // Fire-and-forget — selectCachedSub installs the cues + syncs
      // subSource / subTargetLang / subsApplied so the picker
      // highlight matches reality. We don't await it: the player
      // mounts in parallel with the silent cache fetch. `auto: true`
      // so a `local:` (needs-whisper) pick is skipped, not generated.
      void selectCachedSub(auto, true);
    } else if (transcribeAvailable.v) {
      // /transcribe cache hit for the CURRENT config (different shape
      // than the sidecar list — uses raw transcribe URL). Treat as
      // ready and let the reactive load it.
      dbg('[cinema] openPlayer: /transcribe cache hit → auto subs');
      generateOpen = false;
      subSource.v = 'auto';
      subsApplied = true;
      activeSubKey = 'off';     // no matching sidecar — leave Off until reactive applies
    } else if (localHasSrt) {
      dbg('[cinema] openPlayer: shipped .srt only → enabling orig');
      generateOpen = false;
      subSource.v = 'orig';
      subsApplied = true;
      activeSubKey = 'shipped';
    } else {
      // No subs anywhere — default wizard to generate so the CTA is
      // obvious. User still has to click START.
      dbg('[cinema] openPlayer: no subs found → wizard primed for generate');
      generateOpen = false;
      subSource.v = 'auto';
      subsApplied = false;
      activeSubKey = 'off';
    }
  }

  return {
    // Read by the player UI and the page's reactive blocks.
    subsCtl, subsTick,
    subSource, translateActive, subTrack, subEngine, subTargetLang, subSourceLang,
    generateRequested, transcribeAvailable, transcribeEngine, transcribeModel,
    translateBusy, transcribeBusy, translateError, translateMode,
    transcribeJustDone, transcribeCueCount,
    federatedSubs, federatedRefreshing, federatedTrustOnly, federatedError,
    publishersMap, downloadingRowIds,
    // Called by the page and the player.
    loadSubInfo, loadTranscribeInfo, probeTranscribeCache,
    trackSrc, maybeLoadTranscript,
    loadFederatedSubs, downloadFederated,
    resetForOpen, resetForFile, resetOnClose, recoverOnOpen,
  };
}

export type SubsPipeline = ReturnType<typeof createSubsPipeline>;

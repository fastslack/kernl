import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import { log } from "../../../../../src/core/logger.js";
import { guardOutboundUrl } from "../../../../../src/core/url-guard.js";
import { parseSubs, encodeVtt, langName } from "./subtitles.js";
import {
  translateBatch,
  isLlmChainAvailable,
  type TranslateEngine,
  type TranslateProgress,
} from "./translate.js";
import { llm } from "../../../../../src/core/llm/client.js";
import {
  transcribe,
  isGroqAvailable as isGroqWhisperAvailable,
  wrapThroughProxy,
  type TranscribeEngine,
} from "./transcribe.js";
import { mediaToolBin, mediaToolError, probeMediaTool } from "../../../../../src/core/media-tools.js";
import type { TranscribeJobService, TranscribeRunner } from "./transcribe-jobs.js";
import type { ConvertJobService } from "./convert-jobs.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// Module-scope cache for ffprobe duration lookups. Shared by /probe and
// reused on the rare second call from the same client tab. Bounded by URL
// uniqueness — entries are tiny and we only care about the last 5 min.
const probeDurationCache = new Map<string, { value: number | null; at: number }>();
/** Same 5-min window, but for the full probe (duration + codecs). */
const probeInfoCache = new Map<string, { value: ProbeInfo; at: number }>();

/** Normalize the user-supplied engine name. Legacy values that used to
 *  pick a specific provider (grok / lmstudio / ollama / openai / claude /
 *  llm) all collapse to "llm" — the central LlmClient + the chain at
 *  /models decides the actual provider. Only "nllb" stays distinct
 *  because it's an offline, non-OpenAI-compatible path. */
function normalizeEngine(raw: string | null | undefined, fallback: TranslateEngine = "llm"): TranslateEngine {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "nllb") return "nllb";
  if (!v) return fallback;
  return "llm";
}

// In-memory fan-out for subs pipeline progress (transcribe + translate).
// Keyed by client-supplied `jobId`; values are the set of SSE writers
// currently listening for that job. The /transcribe, /translate-srt and
// /subs handlers `publishSubsProgress(jobId, …)` as work advances; the
// SSE endpoint adds/removes writers on connect/close.
type SubsProgressEvent =
  // ── transcribe phase ──
  | { phase: "transcribe-start"; engine: string; model: string; lang: string }
  | {
      phase: "transcribe-progress";
      /** Overall best-effort fraction (carries through the legacy bar code path). */
      frac: number;
      /** Which step inside the transcribe pipeline is running right now. */
      subPhase: "probe" | "load-model" | "extract" | "transcribe";
      /** Audio seconds processed so far (extract/transcribe) — UI shows "X of Y". */
      processedSec?: number;
      /** Audio seconds total when known (or MB when subPhase=load-model). */
      totalSec?: number;
      /** Short label shown under the bar (e.g. "ffmpeg", "ggml-base.bin"). */
      hint?: string;
    }
  | { phase: "transcribe-done"; cueCount: number; elapsedMs: number }
  | { phase: "transcribe-error"; error: string }
  // ── translate phase ──
  | (TranslateProgress & { phase: "progress" })
  | { phase: "start"; cuesTotal: number; engine: string; src: string; tgt: string }
  | { phase: "done" }
  | { phase: "error"; error: string };
const subsProgressSubs = new Map<string, Set<(evt: SubsProgressEvent) => void>>();

/**
 * Coalesce concurrent transcribe runs. Two browser fetches that arrive
 * within the same few seconds (reactive svelte re-fires, double-clicks,
 * page reload while a generate is in flight) used to each spawn their own
 * whisper.cpp process for the SAME (url, engine, model, lang) — wasting
 * minutes of CPU and doubling progress events on the shared SSE channel.
 *
 * Now the first request claims the key and stores its Promise. Late
 * arrivals await the same Promise and get the same bytes when it
 * resolves. The map entry is cleared in a `finally` so a future call
 * after the cache file lands re-enters the cache-hit branch instead of
 * sticking on a dead Promise.
 *
 * Keys = sha1-derived transcribeKey / finalKey computed in the handler.
 * Values = Promise resolving to the cached VTT text (UTF-8).
 */
const inflightTranscribes = new Map<string, Promise<string>>();

/** Tail-slice that preserves the URL scheme — `https://…/last-60-chars`
 *  instead of `://archive.org/…` (which is what `target.slice(-60)` did
 *  and made the kernel logs look like the URL was malformed). */
function shortUrl(u: string): string {
  if (u.length <= 80) return u;
  const m = /^(https?:\/\/[^/]+)/i.exec(u);
  const host = m?.[0] ?? "";
  const tail = u.slice(-(80 - host.length - 1));
  return host ? `${host}…${tail}` : `…${u.slice(-80)}`;
}

function publishSubsProgress(jobId: string, evt: SubsProgressEvent): void {
  if (!jobId) return;
  const subs = subsProgressSubs.get(jobId);
  if (!subs || subs.size === 0) return;
  for (const send of subs) {
    try { send(evt); } catch { /* writer broken — let close handler clean up */ }
  }
}

// ffprobe wrapper with built-in retry + exponential backoff for transient
// upstream 5xx errors (archive.org has frequent hiccups). Sets
// reconnect/timeout flags so a slow CDN doesn't kill the whole probe.
//
// On 5xx we wait 500ms / 1500ms / 4000ms before each retry. Final failure
// resolves to null so the caller can fall back gracefully (the cinema
// player just shows "duration unknown" instead of crashing).
/**
 * Codec names the browsers we target can decode from a plain progressive
 * download. Anything outside this list has to go through the transcoder.
 *
 * Deliberately conservative: MPEG-4 Part 2 (`mpeg4`, DivX/Xvid rips, which
 * archive.org is full of), H.265, VC-1, MPEG-2 and friends all render as a
 * black frame or fire a bare `src not supported`, and both failure modes cost
 * a full load-fail-reload cycle to discover at runtime.
 */
const BROWSER_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1", "theora"]);
const BROWSER_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
/** 10-bit and 4:2:2 profiles are not decodable in-browser even for h264. */
const BROWSER_PIX_FMTS = new Set(["yuv420p", "yuvj420p"]);

export interface ProbeInfo {
  duration_sec: number | null;
  video_codec: string;
  audio_codec: string;
  pix_fmt: string;
  /** False when the browser will need the transcoder to play this. */
  browser_playable: boolean;
  /** Short human-readable reason when `browser_playable` is false. */
  reason: string;
}

/** Decide, from ffprobe's stream data, whether a <video> can play this. */
export function classifyPlayability(
  videoCodec: string,
  audioCodec: string,
  pixFmt: string,
): { playable: boolean; reason: string } {
  // No video stream probed — say nothing rather than guess wrong. An unknown
  // is treated as playable so a probe failure can never block a file that
  // would have played fine.
  if (!videoCodec) return { playable: true, reason: "" };
  if (!BROWSER_VIDEO_CODECS.has(videoCodec)) {
    return { playable: false, reason: `video codec ${videoCodec}` };
  }
  if (pixFmt && !BROWSER_PIX_FMTS.has(pixFmt)) {
    return { playable: false, reason: `pixel format ${pixFmt}` };
  }
  if (audioCodec && !BROWSER_AUDIO_CODECS.has(audioCodec)) {
    return { playable: false, reason: `audio codec ${audioCodec}` };
  }
  return { playable: true, reason: "" };
}

async function probeDurationWithRetry(
  parsed: URL,
  ua: string,
  maxAttempts = 3,
): Promise<number | null> {
  const { spawn } = await import("node:child_process");
  const args = [
    "-v", "error",
    "-user_agent", `Kernl/${ua}`,
    // ffprobe-specific HTTP retry/timeout — analogous to ffmpeg's
    // -reconnect flags. icy_metadata=0 avoids hangs on stations that
    // send Shoutcast metadata; rw_timeout caps any single read at 10s
    // (microseconds), preventing stalls on flaky CDNs.
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-rw_timeout", "10000000",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    parsed.toString(),
  ];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await new Promise<number | null | "retry">((resolve) => {
      const probe = spawn(mediaToolBin("ffprobe"), args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let stderr = "";
      probe.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
      probe.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
      const killer = setTimeout(() => { try { probe.kill("SIGTERM"); } catch { /* */ } }, 20_000);
      probe.on("exit", (code) => {
        clearTimeout(killer);
        if (code === 0) {
          const n = parseFloat(out.trim());
          return resolve(Number.isFinite(n) && n > 0 ? n : null);
        }
        const stderrSnip = stderr.trim().slice(0, 200);
        // 5xx, 502/503/504, "Server returned 5XX", connection reset
        // — all transient, worth retrying. 4xx, "Permission denied",
        // "Invalid argument" are permanent — bail.
        const transient = /5XX|503|502|504|Connection reset|Connection refused|Operation timed out|EOF/i.test(stderrSnip);
        if (transient && attempt < maxAttempts) {
          log.warn(`ffprobe attempt ${attempt}/${maxAttempts} failed (transient) for ${parsed.host}${parsed.pathname}: ${stderrSnip}`);
          return resolve("retry");
        }
        log.warn(`ffprobe failed (${code}) for ${parsed.host}${parsed.pathname}: ${stderrSnip}`);
        resolve(null);
      });
      probe.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(killer);
        // A missing ffprobe used to look identical to an unprobeable file:
        // both returned null and the duration silently stayed empty. Log it
        // once with the install command so the cause is discoverable.
        if (e?.code === "ENOENT") log.warn(mediaToolError("ffprobe", e).message);
        resolve(null);
      });
    });
    if (result === "retry") {
      await new Promise((r) => setTimeout(r, [500, 1500, 4000][attempt - 1] ?? 4000));
      continue;
    }
    return result;
  }
  return null;
}

/**
 * One ffprobe call for everything the player needs before it picks a source:
 * duration AND the codecs, so the browser is never handed a file it cannot
 * decode.
 *
 * Without this the player was purely reactive — it loaded the raw file, waited
 * for `<video on:error>` (or a 2.5s black-frame watchdog), then tore the
 * element down and reloaded through the transcoder. Every unplayable file cost
 * two loads, several seconds of black screen, and an alarming banner for what
 * is a routine property of half the archive.org catalog.
 *
 * Failure is soft on purpose: a probe that does not come back reports
 * `browser_playable: true`, which lands on the old reactive path rather than
 * sending a perfectly good h264 file through ffmpeg for no reason.
 */
async function probeMediaInfo(parsed: URL, ua: string): Promise<ProbeInfo> {
  const empty: ProbeInfo = {
    duration_sec: null, video_codec: "", audio_codec: "", pix_fmt: "",
    browser_playable: true, reason: "",
  };
  const { spawn } = await import("node:child_process");
  const args = [
    "-v", "error",
    "-user_agent", `Kernl/${ua}`,
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-rw_timeout", "10000000",
    "-show_entries", "format=duration:stream=codec_name,codec_type,pix_fmt",
    "-of", "json",
    parsed.toString(),
  ];
  const raw = await new Promise<string | null>((resolve) => {
    const probe = spawn(mediaToolBin("ffprobe"), args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let stderr = "";
    probe.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    probe.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    const killer = setTimeout(() => { try { probe.kill("SIGTERM"); } catch { /* */ } }, 20_000);
    probe.on("exit", (code) => {
      clearTimeout(killer);
      if (code === 0) return resolve(out);
      log.warn(`ffprobe(info) failed (${code}) for ${parsed.host}${parsed.pathname}: ${stderr.trim().slice(0, 200)}`);
      resolve(null);
    });
    probe.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(killer);
      if (e?.code === "ENOENT") log.warn(mediaToolError("ffprobe", e).message);
      resolve(null);
    });
  });
  if (!raw) return empty;

  try {
    const j = JSON.parse(raw) as {
      format?: { duration?: string };
      streams?: Array<{ codec_name?: string; codec_type?: string; pix_fmt?: string }>;
    };
    const streams = j.streams ?? [];
    const v = streams.find((s) => s.codec_type === "video");
    const a = streams.find((s) => s.codec_type === "audio");
    const d = parseFloat(j.format?.duration ?? "");
    const videoCodec = (v?.codec_name ?? "").toLowerCase();
    const audioCodec = (a?.codec_name ?? "").toLowerCase();
    const pixFmt = (v?.pix_fmt ?? "").toLowerCase();
    const { playable, reason } = classifyPlayability(videoCodec, audioCodec, pixFmt);
    return {
      duration_sec: Number.isFinite(d) && d > 0 ? d : null,
      video_codec: videoCodec,
      audio_codec: audioCodec,
      pix_fmt: pixFmt,
      browser_playable: playable,
      reason,
    };
  } catch {
    return empty;
  }
}

// Sidecar metadata for cached subtitle .vtt files. Written next to each
// VTT as <sha1>.json so /api/torrents/subs/list can enumerate cache hits
// for a video URL without trying every (engine, model, lang) combo.
interface SubsSidecar {
  key: string;
  kind: 'transcribe' | 'translation';
  url: string;                 // upstream video URL
  src_lang: string;
  tgt_lang: string;
  engine?: string;             // whisper for transcribe, LLM for translation
  model?: string;
  cue_count?: number;
  created_at: number;
}
/**
 * Extract a direct HTTP URL for a specific file inside a torrent by
 * combining the magnet's `ws=` (webseed, BEP-19) entries with the
 * file's path inside the torrent. Used by the stream endpoint as a
 * fast fallback when the rust backend doesn't have the torrent loaded
 * — most archive.org torrents include `ws=https://archive.org/download/`,
 * so we can stream the .mp4 / .m4v / .pdf directly with full HTTP Range
 * support without ever resolving DHT metadata.
 *
 * Skips localhost-pointing webseeds (those are self-references that
 * would loop) and webseed-proxy URLs (already wrapped — would double-wrap).
 */
function extractWebseedFileUrl(
  magnet: string,
  torrent: { name?: string; files?: Array<{ name: string }> } | null | undefined,
  fileIdx: number,
): string | null {
  try {
    // Magnet's ws= entries are URL-encoded; URL parser extracts them.
    const u = new URL(magnet.replace(/^magnet:/, "http://x/"));
    const params = u.searchParams.getAll("ws");
    const dn = u.searchParams.get("dn") ?? "";
    const filename =
      torrent?.files?.[fileIdx]?.name
      ?? (dn ? `${dn}/${dn}.mp4` : null);  // fallback guess for single-file
    if (!filename) return null;
    for (const ws of params) {
      let base = ws;
      // archive.org puts loopback webseeds in their magnets pointing
      // back at our own webseed-proxy — skip those (would infinite-loop).
      if (/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(base)) continue;
      if (base.includes("/api/cinema/media/webseed-proxy")) continue;
      if (!base.endsWith("/")) base += "/";
      // Path inside webseed: <identifier>/<file path>
      // For archive.org, ws is `https://archive.org/download/` and the
      // filename already contains the identifier prefix. Test the URL
      // structure:
      //   ws=https://archive.org/download/  +  identifier/file.mp4
      // For other webseeds:
      //   ws=https://example.com/torrents/ + filename.mp4
      // We try the simplest concatenation; webseed-proxy validates HTTP.
      // dn is the torrent root → for files inside it, prefix.
      const candidate = filename.startsWith(dn) ? `${base}${filename}` : `${base}${dn}/${filename}`;
      return candidate;
    }
  } catch { /* malformed magnet */ }
  return null;
}

/**
 * Generate candidate (sha1 + metadata) tuples that the cache MIGHT have
 * for a given upstream URL. Used by /subs/list as a fallback so legacy
 * .vtt files (cached before the sidecar feature existed) still appear in
 * the SELECT row. Only checks combinations the cinema UI actually
 * generates — exhaustive enumeration would be wasteful.
 */
interface LegacyCandidate {
  key: string;
  kind: 'transcribe' | 'translation';
  src_lang: string;
  tgt_lang: string;
  engine: string;
  model: string;
}
function enumerateLegacyKeyCandidates(target: string): LegacyCandidate[] {
  const out: LegacyCandidate[] = [];
  const wEngines = ["whispercpp", "transformers", "groq"] as const;
  const wModels  = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"] as const;
  const tEngines = ["lmstudio", "ollama", "grok", "nllb"] as const;
  const langs    = ["en", "es", "fr", "pt", "de", "it", "ja", "zh", "ko"] as const;

  for (const w of wEngines) {
    for (const m of wModels) {
      for (const lang of langs) {
        const key = createHash("sha1")
          .update(`transcribe|${target}|${w}|${m}|${lang}`)
          .digest("hex");
        out.push({ key, kind: "transcribe", src_lang: lang, tgt_lang: lang, engine: w, model: m });
      }
    }
  }
  for (const src of langs) {
    for (const tgt of langs) {
      if (src === tgt) continue;
      for (const t of tEngines) {
        // /translate-srt cache key: sha1(target|src|tgt|engine).
        const key = createHash("sha1")
          .update(`${target}|${src}|${tgt}|${t}`)
          .digest("hex");
        out.push({ key, kind: "translation", src_lang: src, tgt_lang: tgt, engine: t, model: "" });
      }
    }
  }
  return out;
}

async function writeSubsSidecar(cacheDir: string, side: SubsSidecar): Promise<void> {
  try {
    const p = path.join(cacheDir, `${side.key}.json`);
    await writeFile(p, JSON.stringify(side, null, 2), 'utf8');
  } catch { /* sidecar is best-effort */ }
}

/** Remove a cached sub's .vtt + .json sidecar. Best-effort; missing is fine. */
async function rmCacheKey(cacheDir: string, key: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/i.test(key)) return; // guard against path traversal
  await rm(path.join(cacheDir, `${key}.vtt`), { force: true }).catch(() => {});
  await rm(path.join(cacheDir, `${key}.json`), { force: true }).catch(() => {});
}

/**
 * Free media-serving layer for the cinema module: proxy/transcode public
 * HTTP media (archive.org), probe duration, list archive.org item files,
 * and the subtitle pipeline (transcribe via whisper, translate via LLM/NLLB).
 * All routes are archive.org-generic — no P2P engine. The Pro torrents module
 * ships its own copy under /api/torrents/* for the seeding player.
 */
/**
 * Shape a transcribe request into the parameters every route below shares.
 *
 * The cache key is the identity of a run: same (url, engine, model, lang)
 * means the same VTT, the same job row and the same on-disk file, whether
 * you got there by starting a run, polling it, or asking twice.
 */
export function parseTranscribeRequest(reqUrl: string):
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      target: string;
      engine: TranscribeEngine;
      model: "tiny" | "base" | "small" | "medium" | "large-v3" | "large-v3-turbo";
      language: string | undefined;
      jobId: string;
      cacheKey: string;
      cacheDir: string;
      cachePath: string;
    } {
  const url = new URL(reqUrl || "/", "http://localhost");
  const target = url.searchParams.get("url") ?? "";
  const engineParam = (url.searchParams.get("engine") ?? "transformers").toLowerCase();
  const model = (url.searchParams.get("model") ?? "base") as
    "tiny" | "base" | "small" | "medium" | "large-v3" | "large-v3-turbo";
  const language = url.searchParams.get("lang") || undefined;
  const jobId = url.searchParams.get("jobId") ?? "";

  const engine: TranscribeEngine = ["whispercpp", "transformers", "groq"].includes(engineParam)
    ? (engineParam as TranscribeEngine) : "transformers";

  if (!target) return { ok: false, status: 400, error: "url is required" };
  if (engine === "groq" && !isGroqWhisperAvailable()) {
    return { ok: false, status: 400, error: "groq engine selected but GROQ_API_KEY is not set" };
  }

  const cacheKey = createHash("sha1")
    .update(`transcribe|${target}|${engine}|${model}|${language ?? "auto"}`)
    .digest("hex");
  const cacheDir = path.join(process.cwd(), "data", "subtitles");
  return {
    ok: true,
    target, engine, model, language, jobId, cacheKey, cacheDir,
    cachePath: path.join(cacheDir, `${cacheKey}.vtt`),
  };
}

/**
 * The work itself, minus any notion of who asked for it.
 *
 * Writes the VTT and its sidecar into the cache and returns the cue count.
 * Both the job runner and the legacy blocking route go through here, so
 * there is exactly one implementation of "transcribe and cache".
 */
export async function runTranscribeToCache(
  p: {
    target: string;
    engine: TranscribeEngine;
    model: "tiny" | "base" | "small" | "medium" | "large-v3" | "large-v3-turbo";
    language: string | undefined;
    jobId: string;
    cacheKey: string;
    cacheDir: string;
    cachePath: string;
  },
  onProgress?: (q: {
    subPhase: string; frac: number;
    processedSec?: number; totalSec?: number; hint?: string;
  }) => void,
): Promise<{ cueCount: number; vtt: string }> {
  const t0 = Date.now();
  log.info(
    `transcribe: ${shortUrl(p.target)} · engine=${p.engine} · model=${p.model} · lang=${p.language ?? "auto"}`,
  );
  publishSubsProgress(p.jobId, {
    phase: "transcribe-start", engine: p.engine, model: p.model, lang: p.language ?? "auto",
  });
  const cues = await transcribe(p.engine, p.target, {
    model: p.model,
    language: p.language,
    onProgress: (q) => {
      // The SSE feed is what moves a watching tab's bar; the job row is what
      // a tab that wasn't watching reads later. Both get every tick — the
      // service decides how often to persist.
      publishSubsProgress(p.jobId, {
        phase: "transcribe-progress",
        frac: q.frac,
        subPhase: q.subPhase,
        processedSec: q.processedSec,
        totalSec: q.totalSec,
        hint: q.hint,
      });
      onProgress?.(q);
    },
  });
  log.info(`transcribe: ${cues.length} cues in ${Date.now() - t0}ms`);
  const generated = encodeVtt(cues);
  await mkdir(p.cacheDir, { recursive: true });
  await writeFile(p.cachePath, generated, "utf8");
  await writeSubsSidecar(p.cacheDir, {
    key: p.cacheKey,
    kind: "transcribe",
    url: p.target,
    src_lang: p.language ?? "auto",
    tgt_lang: p.language ?? "auto",
    engine: p.engine,
    model: p.model,
    cue_count: cues.length,
    created_at: Date.now(),
  });
  publishSubsProgress(p.jobId, {
    phase: "transcribe-done", cueCount: cues.length, elapsedMs: Date.now() - t0,
  });
  return { cueCount: cues.length, vtt: generated };
}

/**
 * The runner the job service drives.
 *
 * Lives here rather than in the service because this is where the cache
 * layout and the SSE fan-out are known; the service only cares that it gets a
 * cue count back and an exception when the run fails.
 */
export function createTranscribeRunner(): TranscribeRunner {
  return async (params, onProgress) => {
    const cacheDir = path.join(process.cwd(), "data", "subtitles");
    const { cueCount } = await runTranscribeToCache(
      {
        target: params.url,
        engine: params.engine as TranscribeEngine,
        model: params.model as "tiny" | "base" | "small" | "medium" | "large-v3" | "large-v3-turbo",
        language: params.lang || undefined,
        jobId: params.jobId ?? "",
        cacheKey: params.key,
        cacheDir,
        cachePath: path.join(cacheDir, `${params.key}.vtt`),
      },
      onProgress,
    );
    return { cueCount };
  };
}

export function registerCinemaMediaRoutes(
  server: KernelHttpServer,
  /**
   * Accessor rather than the service itself: routes are registered while the
   * module is still wiring up, and the job service needs the sqlite handle
   * that arrives with it. Returning null means "not ready" — the transcribe
   * routes fall back to running inline, which is what they did before jobs
   * existed.
   */
  getTranscribeJobs?: () => TranscribeJobService | null,
  /** Same shape, for the download-then-convert fallback. */
  getConvertJobs?: () => ConvertJobService | null,
): void {
  server.get("/api/cinema/media/webseed-proxy", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const target = url.searchParams.get("url") ?? "";
      const guard = await guardOutboundUrl(target);
      if (!guard.ok) return server.json(res, 400, { error: guard.reason });
      const parsed = guard.parsed;
      const fwd: Record<string, string> = { "user-agent": "Kernl/torrent-webseed-proxy" };
      const range = req.headers["range"];
      if (typeof range === "string") fwd["range"] = range;
      // Clients abandon these constantly and by design: the browser seeks, a
      // tab closes, and ffmpeg opens the file, reads the header, then drops
      // the connection to re-request the tail where an MP4 keeps its moov.
      // Without this the upstream fetch outlived every one of them and kept
      // pulling the whole file — 188 MB per abandoned seek — for a reader
      // that had already gone. Enough of those and archive.org throttles the
      // host, at which point NEW requests start hanging or coming back 500,
      // and the symptom shows up somewhere else entirely (a transcode that
      // stalls at zero bytes with ffmpeg sitting at 0% CPU).
      const abort = new AbortController();
      const abortUpstream = () => { try { abort.abort(); } catch { /* already gone */ } };
      res.on("close", abortUpstream);
      res.on("error", abortUpstream);
      // archive.org answers an occasional 5xx under load — observed twice in
      // one evening on the same file that served fine either side of it. The
      // browser does not retry a media request that fails: the <video> stops
      // and stays stopped, so one hiccup ends playback for good. Retry the
      // fetch itself, which is safe because this is a plain ranged GET.
      let upstream = await fetch(parsed.toString(), {
        method: "GET",
        headers: fwd,
        redirect: "follow",
        signal: abort.signal,
      });
      for (let attempt = 1; attempt <= 2 && upstream.status >= 500 && !abort.signal.aborted; attempt++) {
        log.warn(`webseed-proxy: upstream ${upstream.status} for ${parsed.host}${parsed.pathname} — retry ${attempt}/2`);
        try { await upstream.body?.cancel(); } catch { /* nothing buffered yet */ }
        await new Promise((r) => setTimeout(r, attempt * 400));
        if (abort.signal.aborted) break;
        upstream = await fetch(parsed.toString(), {
          method: "GET",
          headers: fwd,
          redirect: "follow",
          signal: abort.signal,
        });
      }
      const passthrough: Record<string, string> = {};
      for (const k of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "last-modified",
        "etag",
      ]) {
        const v = upstream.headers.get(k);
        if (v) passthrough[k] = v;
      }
      // CRITICAL: if the browser sent Range but upstream returned 200
      // (= full body, ignored Range) the upstream's content-length is
      // for the WHOLE file, not the requested slice. Forwarding it as-is
      // gives the browser ERR_CONTENT_LENGTH_MISMATCH because the actual
      // bytes received don't match the declared size for the slice it
      // expected. Drop content-length in that case — browser will
      // chunked-decode and accept whatever arrives.
      if (range && upstream.status === 200) {
        delete passthrough["content-length"];
      }
      passthrough["cache-control"] = "no-store";
      res.writeHead(upstream.status, passthrough);
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (!abort.signal.aborted && !res.writableEnded && !res.destroyed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && !res.write(Buffer.from(value))) {
            // Waiting on `drain` alone is a permanent stall when the client
            // is the thing that went away: a closed socket never drains. Race
            // the backpressure against the end of the connection so the loop
            // always has a way out.
            await new Promise<void>((resolve) => {
              const done = () => {
                res.off("drain", done);
                res.off("close", done);
                res.off("error", done);
                resolve();
              };
              res.once("drain", done);
              res.once("close", done);
              res.once("error", done);
            });
          }
        }
        if (!res.writableEnded) res.end();
      };
      try { await pump(); }
      catch (err) {
        // An abort here is the normal end of an abandoned stream, not a
        // fault: logging it as one buried the real breakages in noise.
        if (!abort.signal.aborted) {
          log.error("torrents: webseed-proxy stream broke", err);
        }
        try { res.end(); } catch { /* */ }
      } finally {
        // Releases the upstream connection whichever way the loop ended.
        try { await reader.cancel(); } catch { /* already closed */ }
      }
    } catch (err) {
      // A `<video>` cancels range requests constantly — on seek, once it has
      // buffered enough, when the tab goes away. Since the upstream fetch is
      // now aborted along with them, those land here as AbortError, and
      // answering 502 both logged a failure that did not happen and put a
      // real-looking gateway error in the access log for every ordinary
      // seek. Nobody is listening on a connection the client already closed.
      const clientGone = res.writableEnded || res.destroyed ||
        (err instanceof Error && err.name === "AbortError");
      if (clientGone) {
        try { res.end(); } catch { /* already gone */ }
        return;
      }
      log.error("torrents: webseed-proxy failed", err);
      try { server.json(res, 502, { error: extractMessage(err) }); } catch { /* */ }
    }
  });

  // ── GET /api/torrents/transcode?url=… — live ffmpeg transcode to MP4 ─
  // For formats browsers can't play natively (mpg, avi, m2v, wmv, flv,
  // mkv with weird codecs). Two-stage:
  //   1. ffprobe the upstream to get the input duration. AVI keeps its
  //      index at the END of the file, so without an explicit probe
  //      ffmpeg will stream forward without ever knowing the total.
  //   2. ffmpeg muxes fragmented MP4 carrying the probed duration so the
  //      browser shows a real timeline from frame 1 (the frontend reads
  //      `x-content-duration` and fixes `video.duration` regardless of
  //      what the fMP4 moov reports).
  server.get("/api/cinema/media/transcode", async (req, res) => {
    let ff: import("node:child_process").ChildProcess | null = null;
    const cleanup = () => {
      if (!ff || ff.killed) return;
      try { ff.kill("SIGTERM"); } catch { /* */ }
      // SIGTERM alone was not enough in practice: ffmpeg blocked on a read
      // from a stalled upstream sat there long after the viewer had gone,
      // still holding its connection. Observed several minutes later, at 0%
      // CPU, with the browser tab long closed. Escalate rather than leak.
      const hard = setTimeout(() => {
        try { if (ff && ff.exitCode === null) ff.kill("SIGKILL"); } catch { /* */ }
      }, 5_000);
      hard.unref?.();
    };
    res.on("close", cleanup);
    res.on("error", cleanup);

    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const target = url.searchParams.get("url") ?? "";

      // Cinema streams archive.org URLs (and other public HTTP media).
      // All targets go through the SSRF guard — the free media layer has no
      // P2P self-stream shortcut (that lives in the Pro torrents module).
      const guard = await guardOutboundUrl(target);
      if (!guard.ok) return server.json(res, 400, { error: guard.reason });
      const parsed: URL = guard.parsed;

      const { spawn } = await import("node:child_process");

      // ── Stage 1: probe duration with ffprobe ────────────────────────
      // Quiet, JSON-shaped, format-only. Times out at 15s — if the
      // server ignores Range requests entirely the probe will hang on
      // large files; better to give up and stream without duration than
      // block the user forever.
      const probeDurationSec = await probeDurationWithRetry(parsed, "torrent-transcode");

      if (probeDurationSec) {
        log.info(`transcode: probed duration ${probeDurationSec.toFixed(2)}s for ${parsed.host}${parsed.pathname}`);
      } else {
        log.warn(`transcode: duration unknown for ${parsed.host}${parsed.pathname} — progress bar will grow as bytes arrive`);
      }

      // ── Stage 2: spawn ffmpeg with the duration we already know ─────
      const ffArgs = [
        "-hide_banner", "-loglevel", "error",
        // HTTP options — reconnect on transient drops AND on HTTP 4xx/5xx
        // (archive.org sometimes returns 503 briefly during peak load).
        // reconnect_on_http_error accepts a comma list of codes; we allow
        // 4xx/5xx so a brief 503 doesn't kill the whole transcode.
        "-reconnect", "1",
        "-reconnect_at_eof", "1",
        "-reconnect_streamed", "1",
        "-reconnect_on_network_error", "1",
        "-reconnect_on_http_error", "4xx,5xx",
        "-reconnect_delay_max", "30",
        "-rw_timeout", "30000000",
        "-user_agent", "Kernl/torrent-transcode",
        // Through our own webseed proxy, never straight at the origin.
        // ffmpeg's libavformat HTTP client cannot follow archive.org's
        // SSL/302 redirect chain: it takes an HTTP 500, keeps the partial
        // body, and then fails to read codec parameters for the video
        // stream — at which point it silently DROPS the video and muxes an
        // audio-only MP4. The browser gets a file it can never show a frame
        // of, so the player sits on "converting for your browser" forever
        // with nothing in any log to explain it. (Tell-tale in ffmpeg's
        // stderr: `preset`/`crf` "not used for any stream" — no video
        // encoder was ever instantiated.) The proxy already handles the UA,
        // the redirects and Range correctly, which is why the transcribe
        // path has gone through it from the start.
        // A/B switch, temporary: CINEMA_TRANSCODE_DIRECT=1 restores the
        // pre-existing behaviour (straight at the origin) so the two paths can
        // be measured against each other on the same file at the same moment.
        // Default through our own webseed proxy: measured against the origin
        // on the same file, direct came back as an audio-only MP4 (ffmpeg took
        // an HTTP 500 mid-probe, kept the partial body and dropped the video
        // stream), while the proxied read produced a well-formed h264+aac
        // stream. CINEMA_TRANSCODE_DIRECT=1 restores the old behaviour for
        // comparison — neither is fast enough to play live, see the note on
        // the location block in nginx.conf.
        "-i", process.env.CINEMA_TRANSCODE_DIRECT === "1"
          ? parsed.toString()
          : wrapThroughProxy(parsed.toString()),
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "frag_keyframe+default_base_moof",
        "-f", "mp4", "pipe:1",
      ];
      ff = spawn(mediaToolBin("ffmpeg"), ffArgs, { stdio: ["ignore", "pipe", "pipe"] });

      ff.on("error", (err) => {
        const friendly = mediaToolError("ffmpeg", err);
        log.error("cinema: transcode ffmpeg spawn failed", friendly);
        try { server.json(res, 500, { error: friendly.message }); }
        catch { /* headers already sent */ }
      });
      ff.stderr?.on("data", (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) log.warn(`ffmpeg: ${msg}`);
      });

      const headers: Record<string, string> = {
        "content-type": "video/mp4",
        "cache-control": "no-store",
        "x-transcoded": "1",
        // Single-pass forward stream — the moov has real duration but the
        // body is non-seekable.
        "accept-ranges": "none",
      };
      if (probeDurationSec) {
        // Frontend reads this and patches `mediaSource.duration` (when
        // MSE is in play) or just renders a custom progress bar. Either
        // way it's the source of truth for total length.
        headers["x-content-duration"] = probeDurationSec.toFixed(3);
        // CORS preflight whitelist so the frontend can actually read it.
        headers["access-control-expose-headers"] = "x-content-duration, x-transcoded";
      }
      res.writeHead(200, headers);
      ff.stdout?.pipe(res);
      ff.on("exit", (code) => {
        if (code !== 0 && code !== null) log.warn(`ffmpeg exited code ${code}`);
        try { res.end(); } catch { /* */ }
      });
    } catch (err) {
      log.error("torrents: transcode failed", err);
      cleanup();
      try { server.json(res, 502, { error: extractMessage(err) }); }
      catch { /* */ }
    }
  });

  // ── GET /api/torrents/probe?url=… — ffprobe duration for a remote URL ─
  // Used by the cinema player to fix `<video>.duration` when streaming a
  // fragmented MP4 from /transcode (the moov has no real total length, so
  // the browser would otherwise treat it as a live stream and show only
  // elapsed-time on the scrubber). 5-minute LRU cache keyed by URL — same
  // file rarely changes and ffprobe on a 1.5 GB MPEG can take 10+ seconds.
  server.get("/api/cinema/media/probe", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const target = url.searchParams.get("url") ?? "";
      let parsed: URL;
      try { parsed = new URL(target); }
      catch { return server.json(res, 400, { error: "invalid url" }); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return server.json(res, 400, { error: "only http(s) urls are allowed" });
      }

      const cached = probeInfoCache.get(target);
      if (cached && Date.now() - cached.at < 5 * 60_000) {
        return server.json(res, 200, { ...cached.value, cached: true });
      }

      const info = await probeMediaInfo(parsed, "torrent-probe");

      probeInfoCache.set(target, { value: info, at: Date.now() });
      server.json(res, 200, { ...info, cached: false });
    } catch (err) {
      server.json(res, 502, { error: extractMessage(err) });
    }
  });

  // ── POST /api/torrents/import-archive/preview — search archive.org ───
  // Returns search results (without registering anything) so the user can
  // pick which items to import. Backed by a 6h SQLite cache keyed by the
  // normalized query params — repeated calls for the same chip/page are
  // served locally without touching archive.org.

  // ── GET /api/torrents/import-archive/files?id=… — list files for an item ──
  // Hits archive.org's metadata API server-side (no CORS for browser),
  // returns the file list ready for the frontend to build playable URLs.
  server.get("/api/cinema/media/import-archive/files", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const id = url.searchParams.get("id") ?? "";
      if (!id) return server.json(res, 400, { error: "id is required" });
      const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`, {
        headers: { "user-agent": "Kernl/archive-importer" },
        redirect: "follow",
      });
      if (!r.ok) return server.json(res, r.status, { error: `upstream ${r.status}` });
      const body = (await r.json()) as {
        metadata?: { title?: string; description?: string };
        files?: Array<{ name: string; size?: string | number; format?: string; length?: string }>;
      };
      const files = (body.files ?? [])
        .map((f) => ({
          name: String(f.name ?? ""),
          size: typeof f.size === "string" ? parseInt(f.size, 10) || 0 : (f.size ?? 0),
          format: f.format ?? "",
          length: f.length ?? "",
        }))
        .filter((f) => f.name && !f.name.startsWith("__ia_") && !/\.(torrent|sqlite|db|epub|pdf|jpg)$/i.test(f.name) || /\.(jpg|png|webp|jpeg|gif)$/i.test(f.name));
      const title = body.metadata?.title ?? id;
      const description = body.metadata?.description ?? "";
      server.json(res, 200, { id, title, description, files });
    } catch (err) {
      log.error("torrents: archive files failed", err);
      server.json(res, 502, { error: extractMessage(err) });
    }
  });

  // ── POST /api/torrents/import-archive/run — register selected items ──

  // ── GET /api/torrents/subs/progress — SSE feed for a subs jobId ──────
  // Carries both transcribe and translate phases. The frontend opens this
  // BEFORE kicking off /transcribe, /translate-srt, or /subs and listens
  // for { phase, frac | cuesDone | etaMs, … } events to drive the progress
  // bar from real data instead of a wall-clock guess.
  // `/translate-srt/progress` is kept as an alias for back-compat with
  // anything that already wired against the original name.
  const subsProgressHandler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const jobId = url.searchParams.get("jobId") ?? "";
    if (!jobId) {
      server.json(res, 400, { error: "jobId is required" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    });
    // Initial flush so the browser fires `onopen` immediately and the
    // frontend knows the channel is live before it triggers the POST.
    res.write(`: ready\n\n`);
    let alive = true;
    const send = (evt: SubsProgressEvent) => {
      if (!alive) return;
      try { res.write(`data: ${JSON.stringify(evt)}\n\n`); }
      catch { alive = false; }
    };
    let subs = subsProgressSubs.get(jobId);
    if (!subs) { subs = new Set(); subsProgressSubs.set(jobId, subs); }
    subs.add(send);
    const cleanup = () => {
      alive = false;
      subs!.delete(send);
      if (subs!.size === 0) subsProgressSubs.delete(jobId);
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    // Heartbeat every 25s — proxies (nginx default 60s, ALB 60s) drop idle
    // SSE connections, and grok/whisper can stall on one batch for 30s+.
    const heartbeat = setInterval(() => {
      if (!alive) { clearInterval(heartbeat); return; }
      try { res.write(`: hb\n\n`); } catch { /* */ }
    }, 25_000);
    req.on("close", () => clearInterval(heartbeat));
  };
  server.get("/api/cinema/media/subs/progress", subsProgressHandler);
  server.get("/api/cinema/media/translate-srt/progress", subsProgressHandler);

  // ── GET /api/torrents/translate-srt — fetch + translate + cache as VTT ─
  // params:
  //   url=<srt-url>        upstream subtitle file (HTTP(S))
  //   src=en               source ISO-639-1 (default "en")
  //   tgt=es               target ISO-639-1 (default "es")
  //   engine=nllb|grok|lmstudio|ollama  (default "nllb")
  //   jobId=<opaque>       optional — when present, progress is published
  //                        on the SSE channel above so the UI bar tracks
  //                        real cues-done/total instead of wall-clock.
  //   passthrough=1                      skip translation, just convert SRT→VTT
  // Caches translated VTT under data/subtitles/<sha>.vtt to avoid re-running
  // the model on the same file.
  server.get("/api/cinema/media/translate-srt", async (req, res) => {
    const jobId = new URL(req.url ?? "/", "http://localhost").searchParams.get("jobId") ?? "";
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const target = url.searchParams.get("url") ?? "";
      const src = (url.searchParams.get("src") ?? "en").toLowerCase();
      const tgt = (url.searchParams.get("tgt") ?? "es").toLowerCase();
      const passthrough = url.searchParams.get("passthrough") === "1";
      // Legacy engine names (grok/lmstudio/ollama/openai/claude) all route
      // through the central LlmClient now — collapse them to "llm" so the
      // chain at /models decides the actual provider. Default stays "nllb"
      // (offline) to preserve the historic safe-by-default contract for
      // API-direct callers that don't specify an engine.
      const engine: TranslateEngine = normalizeEngine(url.searchParams.get("engine"), "nllb");

      if (!target) return server.json(res, 400, { error: "url is required" });
      if (engine === "llm" && !isLlmChainAvailable()) {
        return server.json(res, 400, {
          error: "no LLM provider configured — set up a primary model at /models or use engine=nllb (offline)",
        });
      }

      // Cache key: stable across (url, src, tgt, engine, passthrough flag).
      const cacheKey = createHash("sha1")
        .update(`${target}|${src}|${tgt}|${passthrough ? "raw" : engine}`)
        .digest("hex");
      const cacheDir = path.join(process.cwd(), "data", "subtitles");
      const cachePath = path.join(cacheDir, `${cacheKey}.vtt`);

      if (existsSync(cachePath)) {
        const cached = await readFile(cachePath, "utf8");
        res.writeHead(200, {
          "content-type": "text/vtt; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=86400",
          "x-translate-cache": "hit",
        });
        res.end(cached);
        return;
      }

      // Rewrite self-references — when the frontend passes the upstream as
      // `http://localhost:3086/api/torrents/transcribe?...` (the nginx
      // wrapper port the browser sees), the kernel container can't reach
      // its own host:port; `localhost` inside the container is the
      // container itself, and 3086 is bound on the dashboard container.
      // Route loopback hits straight to the internal HTTP port instead.
      let fetchTarget = target;
      try {
        const u = new URL(target);
        if ((u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.pathname.startsWith("/api/")) {
          const internalPort = process.env.DOCKER_DASHBOARD_PORT
            || process.env.PORT
            || "3087";
          fetchTarget = `http://127.0.0.1:${internalPort}${u.pathname}${u.search}`;
          log.info(`translate-srt: rewrote self-fetch ${u.host} → 127.0.0.1:${internalPort}`);
        }
      } catch { /* not a URL — fall through, fetch will error */ }

      // Fetch SRT (server-side, no CORS). When `fetchTarget` is a loopback
      // /api/... URL it goes through the kernel's auth gate, so we forward
      // KERNEL_AUTH_TOKEN as a Bearer header.
      const selfAuthHeaders: Record<string, string> = { "user-agent": "Kernl/translate-srt" };
      const selfToken = process.env.KERNEL_AUTH_TOKEN ?? "";
      if (selfToken && /^https?:\/\/(?:localhost|127\.0\.0\.1)/i.test(fetchTarget)) {
        selfAuthHeaders["authorization"] = `Bearer ${selfToken}`;
      }
      const upstream = await fetch(fetchTarget, {
        headers: selfAuthHeaders,
        redirect: "follow",
      });
      if (!upstream.ok) {
        return server.json(res, upstream.status, { error: `upstream ${upstream.status}` });
      }
      const raw = await upstream.text();
      const cues = parseSubs(raw);
      if (!cues.length) {
        // Distinguish the two ways this happens. archive.org publishes
        // zero-byte subtitle derivatives when its speech recognition pass
        // produced nothing, and reporting that as a parse failure sent people
        // looking for a bug in the parser instead of at an empty file.
        return server.json(res, 422, {
          error: raw.trim().length === 0
            ? "the subtitle file is empty upstream — nothing to show"
            : "no cues parsed — the file is not a subtitle format we read",
        });
      }

      let outCues = cues;
      let actualProvider: string | undefined;
      let actualModel: string | undefined;
      if (!passthrough) {
        const t0 = Date.now();
        log.info(`translate-srt: ${cues.length} cues · ${src}→${tgt} · ${engine}`);
        publishSubsProgress(jobId, { phase: "start", cuesTotal: cues.length, engine, src, tgt });
        const result = await translateBatch(engine, cues.map(c => c.text), {
          src, tgt,
          onProgress: jobId ? (p) => publishSubsProgress(jobId, { phase: "progress", ...p }) : undefined,
        });
        const { translations } = result;
        actualProvider = result.providerUsed;
        actualModel = result.modelUsed;
        const nonEmpty = translations.filter(t => t && t.trim().length > 0).length;
        const sample = translations.slice(0, 3).map((t, i) => `[${i}] in="${cues[i]?.text?.slice(0, 60) ?? ""}" out="${(t ?? "").slice(0, 60)}"`).join(" | ");
        log.info(`translate-srt: ${nonEmpty}/${translations.length} non-empty · sample: ${sample}`);
        if (nonEmpty === 0) {
          return server.json(res, 502, {
            error: `${engine} returned all-empty translations (model likely unavailable or input rejected).`,
          });
        }
        let identical = 0;
        for (let i = 0; i < translations.length; i++) {
          if (translations[i] && translations[i].trim() === cues[i]?.text?.trim()) identical++;
        }
        const identicalPct = (identical / translations.length) * 100;
        if (identicalPct > 50 && src !== tgt) {
          // Distinguish the two ways this guard trips. "Batches that never got
          // an answer keep their source text" and "the model echoed the input"
          // look identical from the cue ratio alone, and only the first one
          // tells you to go look at provider errors.
          const fb = result.fallbackBatches ?? 0;
          const tb = result.totalBatches ?? 0;
          const because = fb > 0
            ? `${fb}/${tb} batch(es) never got an answer from the provider and kept their source text`
            : `the model echoed the input`;
          log.warn(`translate-srt: rejecting run — ${identicalPct.toFixed(0)}% unchanged; ${because}`);
          return server.json(res, 502, {
            error: `${engine}: ${identicalPct.toFixed(0)}% of cues unchanged — ${because}.`,
            fallback_batches: fb,
            total_batches: tb,
            sample,
          });
        }
        outCues = cues.map((c, i) => ({ ...c, text: translations[i] || c.text }));
        log.info(`translate-srt: done in ${Date.now() - t0}ms · provider=${actualProvider ?? engine} · model=${actualModel ?? "?"}`);
      }

      const vtt = encodeVtt(outCues);
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, vtt, "utf8");
      // Sidecar — translate-srt is also called as the second phase of the
      // unified frontend pipeline, so its outputs need to show in the
      // SELECT row. The "url" field is the ORIGINAL upstream (could be a
      // shipped .srt or our own /transcribe URL); we still record it so
      // the cinema page's refreshCachedSubs() can find translations
      // associated with the video the user is watching. For the auto+
      // translate path the upstream is the kernel's own /transcribe URL
      // — try to extract the embedded video URL so the sidecar lines up.
      let sidecarUrl = target;
      try {
        const u = new URL(target);
        const inner = u.searchParams.get("url");
        if (inner && u.pathname.includes("/api/cinema/media/transcribe")) sidecarUrl = inner;
      } catch { /* keep target as-is */ }
      await writeSubsSidecar(cacheDir, {
        key: cacheKey,
        kind: passthrough ? "transcribe" : "translation",
        url: sidecarUrl,
        src_lang: src,
        tgt_lang: tgt,
        engine: passthrough ? undefined : engine,
        model: passthrough ? undefined : actualModel,
        cue_count: outCues.length,
        created_at: Date.now(),
      });

      const engineHeader = passthrough
        ? "passthrough"
        : actualProvider ? `${engine}:${actualProvider}` : engine;
      res.writeHead(200, {
        "content-type": "text/vtt; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=86400",
        "x-translate-cache": "miss",
        "x-translate-engine": engineHeader,
        "x-translate-model": actualModel ?? "",
        "x-translate-langs": `${src}->${tgt}`,
        "x-translate-cues": String(cues.length),
      });
      res.end(vtt);
      if (!passthrough) publishSubsProgress(jobId, { phase: "done" });
    } catch (err) {
      log.error("torrents: translate-srt failed", err);
      publishSubsProgress(jobId, { phase: "error", error: extractMessage(err) });
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/torrents/subs — unified transcribe + translate pipeline ─
  // params:
  //   url=<video-url>                   (required)
  //   lang=en                           source language (default "en")
  //   tgt=es                            target language (default = lang, ie. no translation)
  //   transcribe_engine=whispercpp      (default whispercpp, options: whispercpp|transformers|groq)
  //   transcribe_model=base             (default base, options: tiny|base|small|medium|large-v3)
  //   translate_engine=lmstudio         (only used when tgt != lang)
  //
  // Behaviour:
  //   1. Compute final cache key (full pipeline) and short-circuit if cached.
  //   2. Otherwise: get the source-language transcript (re-uses transcribe cache).
  //   3. If tgt == lang, return the transcript as-is.
  //   4. Else translate via translate_engine, cache the final VTT, return.
  //
  // Two cache layers means a re-run with a different translate engine reuses
  // the existing whisper transcript without re-running whisper.
  server.get("/api/cinema/media/subs", async (req, res) => {
    const jobId = new URL(req.url ?? "/", "http://localhost").searchParams.get("jobId") ?? "";
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const target = url.searchParams.get("url") ?? "";
      const srcLang = (url.searchParams.get("lang") ?? "en").toLowerCase();
      const tgtLang = (url.searchParams.get("tgt") ?? srcLang).toLowerCase();
      const wEngineParam = (url.searchParams.get("transcribe_engine") ?? "whispercpp").toLowerCase();
      const wModelParam = url.searchParams.get("transcribe_model") ?? "base";
      const wEngine: TranscribeEngine = ["whispercpp", "transformers", "groq"].includes(wEngineParam)
        ? (wEngineParam as TranscribeEngine) : "whispercpp";
      const wModel = (["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"].includes(wModelParam) ? wModelParam : "base") as
        "tiny" | "base" | "small" | "medium" | "large-v3" | "large-v3-turbo";
      // Legacy translate_engine values (grok/lmstudio/ollama/openai/claude)
      // all collapse to "llm" — the chain at /models picks the actual
      // provider and falls back automatically on quota/auth errors.
      const tEngine: TranslateEngine = normalizeEngine(url.searchParams.get("translate_engine"), "llm");

      if (!target) return server.json(res, 400, { error: "url is required" });
      if (wEngine === "groq" && !isGroqWhisperAvailable()) {
        return server.json(res, 400, { error: "groq transcribe engine selected but GROQ_API_KEY is not set" });
      }
      const willTranslate = tgtLang !== srcLang;
      if (willTranslate && tEngine === "llm" && !isLlmChainAvailable()) {
        return server.json(res, 400, {
          error: "no LLM provider configured — set up a primary model at /models or use translate_engine=nllb (offline)",
        });
      }

      const cacheDir = path.join(process.cwd(), "data", "subtitles");
      await mkdir(cacheDir, { recursive: true });

      // ── Cache layer 1: final pipeline result. ────────────────────
      const finalKey = createHash("sha1")
        .update(`subs|${target}|${srcLang}|${tgtLang}|${wEngine}|${wModel}|${willTranslate ? tEngine : "raw"}`)
        .digest("hex");
      const finalPath = path.join(cacheDir, `${finalKey}.vtt`);

      // ── Cache layer 2: source-language transcript (reusable across
      //    different translation engines). Computed up front so a forced
      //    re-run can drop it. Same key shape as the standalone
      //    /transcribe endpoint so they share the file.
      const transcribeKey = createHash("sha1")
        .update(`transcribe|${target}|${wEngine}|${wModel}|${srcLang}`)
        .digest("hex");
      const transcribePath = path.join(cacheDir, `${transcribeKey}.vtt`);

      // ── Forced re-run: drop cached artifacts so the pipeline recomputes.
      //   force=translate  → drop only the final VTT, reuse the transcript
      //                      (cheap: re-translate an existing transcript)
      //   force=transcribe → drop transcript AND final (full re-run from audio)
      // The UI's "re-run translation / re-run transcription" buttons send these.
      const force = (url.searchParams.get("force") ?? "").toLowerCase();
      if (force === "translate" || force === "transcribe") {
        await rmCacheKey(cacheDir, finalKey);
        if (force === "transcribe") await rmCacheKey(cacheDir, transcribeKey);
        log.info(`subs: force=${force} → cleared cache for ${shortUrl(target)}`);
      }

      if (existsSync(finalPath)) {
        const cached = await readFile(finalPath, "utf8");
        res.writeHead(200, {
          "content-type": "text/vtt; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=86400",
          "x-subs-cache": "hit",
          "x-subs-pipeline": willTranslate ? `${wEngine}/${wModel} -> ${tEngine}` : `${wEngine}/${wModel}`,
        });
        res.end(cached);
        return;
      }

      let transcribedVtt: string;
      if (existsSync(transcribePath)) {
        log.info(`subs: transcribe cache hit for ${shortUrl(target)}`);
        transcribedVtt = await readFile(transcribePath, "utf8");
      } else {
        // Coalesce: if another request is already running whisper for the
        // exact same (url, engine, model, lang), join its Promise instead
        // of starting a second whisper process. Browser reactives fire
        // multiple fetches within seconds — this stops them from each
        // spawning their own minutes-long whisper run.
        const existing = inflightTranscribes.get(transcribeKey);
        if (existing) {
          log.info(`subs: joining in-flight transcribe ${wEngine}/${wModel} for ${shortUrl(target)}`);
          transcribedVtt = await existing;
        } else {
          log.info(`subs: running transcribe ${wEngine}/${wModel} on ${shortUrl(target)}`);
          const runPromise = (async () => {
            const t0 = Date.now();
            publishSubsProgress(jobId, { phase: "transcribe-start", engine: wEngine, model: wModel, lang: srcLang });
            const cues = await transcribe(wEngine, target, {
              model: wModel, language: srcLang,
              onProgress: jobId ? (p) => publishSubsProgress(jobId, {
                phase: "transcribe-progress",
                frac: p.frac,
                subPhase: p.subPhase,
                processedSec: p.processedSec,
                totalSec: p.totalSec,
                hint: p.hint,
              }) : undefined,
            });
            log.info(`subs: transcribe done — ${cues.length} cues in ${Date.now() - t0}ms`);
            publishSubsProgress(jobId, { phase: "transcribe-done", cueCount: cues.length, elapsedMs: Date.now() - t0 });
            const vtt = encodeVtt(cues);
            await writeFile(transcribePath, vtt, "utf8");
            await writeSubsSidecar(cacheDir, {
              key: transcribeKey,
              kind: "transcribe",
              url: target,
              src_lang: srcLang,
              tgt_lang: srcLang,
              engine: wEngine,
              model: wModel,
              cue_count: cues.length,
              created_at: Date.now(),
            });
            return vtt;
          })();
          inflightTranscribes.set(transcribeKey, runPromise);
          try {
            transcribedVtt = await runPromise;
          } finally {
            inflightTranscribes.delete(transcribeKey);
          }
        }
      }

      // No translation needed — return the transcript and re-cache as the
      // "final" layer so re-runs with same params hit cache layer 1.
      if (!willTranslate) {
        await writeFile(finalPath, transcribedVtt, "utf8");
        res.writeHead(200, {
          "content-type": "text/vtt; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=86400",
          "x-subs-cache": "miss-transcribe-only",
          "x-subs-pipeline": `${wEngine}/${wModel}`,
        });
        res.end(transcribedVtt);
        return;
      }

      // ── Stage 3: translate ────────────────────────────────────────
      const cues = parseSubs(transcribedVtt);
      if (!cues.length) return server.json(res, 422, { error: "transcript has no cues to translate" });

      log.info(`subs: translating ${cues.length} cues · ${srcLang}→${tgtLang} · ${tEngine}`);
      publishSubsProgress(jobId, { phase: "start", cuesTotal: cues.length, engine: tEngine, src: srcLang, tgt: tgtLang });
      const t1 = Date.now();
      const tResult = await translateBatch(tEngine, cues.map(c => c.text), {
        src: srcLang, tgt: tgtLang,
        onProgress: jobId ? (p) => publishSubsProgress(jobId, { phase: "progress", ...p }) : undefined,
      });
      const translations = tResult.translations;
      log.info(`subs: translate done in ${Date.now() - t1}ms · provider=${tResult.providerUsed ?? tEngine} · model=${tResult.modelUsed ?? "?"}`);

      const nonEmpty = translations.filter(t => t && t.trim().length > 0).length;
      if (nonEmpty === 0) {
        return server.json(res, 502, {
          error: `${tEngine} returned all-empty translations (model unavailable or input rejected).`,
        });
      }
      let identical = 0;
      for (let i = 0; i < translations.length; i++) {
        if (translations[i] && translations[i].trim() === cues[i]?.text?.trim()) identical++;
      }
      const identicalPct = (identical / translations.length) * 100;
      if (identicalPct > 50 && srcLang !== tgtLang) {
        return server.json(res, 502, {
          error: `${tEngine}: ${identicalPct.toFixed(0)}% of cues unchanged (passthrough — model failed silently).`,
        });
      }

      const outCues = cues.map((c, i) => ({ ...c, text: translations[i] || c.text }));
      const finalVtt = encodeVtt(outCues);
      await writeFile(finalPath, finalVtt, "utf8");
      await writeSubsSidecar(cacheDir, {
        key: finalKey,
        kind: "translation",
        url: target,
        src_lang: srcLang,
        tgt_lang: tgtLang,
        engine: tEngine,
        model: tResult.modelUsed ?? wModel,
        cue_count: outCues.length,
        created_at: Date.now(),
      });

      const subsEngineHeader = tResult.providerUsed ? `${tEngine}:${tResult.providerUsed}` : tEngine;
      res.writeHead(200, {
        "content-type": "text/vtt; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=86400",
        "x-subs-cache": "miss",
        "x-subs-pipeline": `${wEngine}/${wModel} -> ${subsEngineHeader}`,
        "x-subs-model": tResult.modelUsed ?? "",
        "x-subs-cues": String(cues.length),
      });
      res.end(finalVtt);
      publishSubsProgress(jobId, { phase: "done" });
    } catch (err) {
      // Use extractMessage + raw error properties so the log line is
      // useful — `JSON.stringify(err)` on an Error yields `{}` because
      // Error fields aren't enumerable. Knowing the actual cause turns
      // "subs failed {}" into something diagnosable.
      const msg = extractMessage(err);
      const stack = err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" | ") : "";
      log.error(`torrents: subs failed: ${msg}`, { stack });
      publishSubsProgress(jobId, { phase: "error", error: msg });
      try { server.json(res, 500, { error: msg }); }
      catch { /* response already started */ }
    }
  });

  /**
   * Hand a request to the job service, or run it inline when there is no
   * database to keep jobs in.
   *
   * The service is created during module init; a route that fires before that
   * (or in a stripped-down embedding of these routes) still has to work, and
   * running inline is exactly the old behaviour.
   */
  function startTranscribeJob(
    p: Extract<ReturnType<typeof parseTranscribeRequest>, { ok: true }>,
    cached: { cueCount: number } | null,
  ) {
    const jobs = getTranscribeJobs?.() ?? null;
    if (!jobs) return null;
    return jobs.start(
      {
        key: p.cacheKey,
        url: p.target,
        engine: p.engine,
        model: p.model,
        lang: p.language ?? "",
        jobId: p.jobId,
      },
      cached,
    );
  }

  // ── GET /api/cinema/media/convert/start?url=… — convert, don't stream ─
  // The fallback for sources no browser decodes. Answers immediately; the
  // download-then-convert runs server-side and the result is a cached, and
  // crucially SEEKABLE, mp4 served by /convert/file.
  server.get("/api/cinema/media/convert/start", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const target = url.searchParams.get("url") ?? "";
      if (!target) return server.json(res, 400, { error: "url is required" });
      const guard = await guardOutboundUrl(target);
      if (!guard.ok) return server.json(res, 400, { error: guard.reason });

      const jobs = getConvertJobs?.() ?? null;
      if (!jobs) {
        return server.json(res, 503, {
          error: "conversion is not available yet — the cinema module is still starting",
        });
      }
      const key = createHash("sha1").update(`convert|${target}`).digest("hex");
      // Fetch through our own proxy for the same reason the transcribe path
      // does: ffmpeg and fetch both trip on archive.org's redirect chain, and
      // the proxy already gets the UA, the redirects and Range right.
      const status = jobs.start(key, target, wrapThroughProxy(guard.parsed.toString()));
      server.json(res, 200, status);
    } catch (err) {
      log.error("cinema: convert start failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/cinema/media/convert/status?key=… ───────────────────────
  server.get("/api/cinema/media/convert/status", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const key = (url.searchParams.get("key") ?? "").replace(/[^a-f0-9]/gi, "");
      if (!key || key.length !== 40) {
        return server.json(res, 400, { error: "invalid key (sha1 hex required)" });
      }
      const jobs = getConvertJobs?.() ?? null;
      const status = jobs?.status(key) ?? null;
      if (!status) return server.json(res, 404, { error: "no such conversion" });
      server.json(res, 200, status);
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── DELETE /api/cinema/media/convert?key=… — stop one ────────────────
  server.delete("/api/cinema/media/convert", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const key = (url.searchParams.get("key") ?? "").replace(/[^a-f0-9]/gi, "");
      if (!key || key.length !== 40) {
        return server.json(res, 400, { error: "invalid key (sha1 hex required)" });
      }
      const jobs = getConvertJobs?.() ?? null;
      server.json(res, 200, { cancelled: jobs?.cancel(key) ?? false });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/cinema/media/convert/file?key=… — serve the result ──────
  // Range-aware on purpose. The whole point of converting to a file instead
  // of streaming one is that the viewer can scrub, which needs 206s.
  server.get("/api/cinema/media/convert/file", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const key = (url.searchParams.get("key") ?? "").replace(/[^a-f0-9]/gi, "");
      if (!key || key.length !== 40) {
        return server.json(res, 400, { error: "invalid key (sha1 hex required)" });
      }
      const jobs = getConvertJobs?.() ?? null;
      const file = jobs?.outPath(key) ?? "";
      if (!file || !existsSync(file)) {
        return server.json(res, 404, { error: "not converted (yet)" });
      }
      const { statSync, createReadStream } = await import("node:fs");
      const size = statSync(file).size;
      const range = req.headers["range"];
      const m = typeof range === "string" ? /bytes=(\d*)-(\d*)/.exec(range) : null;

      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
          res.writeHead(416, { "content-range": `bytes */${size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "content-type": "video/mp4",
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${size}`,
          "accept-ranges": "bytes",
          "cache-control": "private, max-age=86400",
        });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": String(size),
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=86400",
      });
      createReadStream(file).pipe(res);
    } catch (err) {
      log.error("cinema: convert file failed", err);
      try { server.json(res, 500, { error: extractMessage(err) }); } catch { /* */ }
    }
  });

  // ── GET /api/cinema/media/transcribe/start — kick off a run ──────────
  // Answers immediately with the job status. The run continues server-side
  // and its progress lands in cinema_transcribe_jobs, so losing this
  // response — reload, navigation, flaky wifi — costs nothing: poll
  // /transcribe/status with the returned key and pick the run back up.
  server.get("/api/cinema/media/transcribe/start", async (req, res) => {
    try {
      const p = parseTranscribeRequest(req.url ?? "/");
      if (!p.ok) return server.json(res, p.status, { error: p.error });

      // A finished run is already durable on disk; report it ready rather
      // than transcribing a film we have captions for.
      let cached: { cueCount: number } | null = null;
      if (existsSync(p.cachePath)) {
        cached = { cueCount: parseSubs(await readFile(p.cachePath, "utf8")).length };
      }

      const jobs = getTranscribeJobs?.() ?? null;
      if (!jobs) {
        return server.json(res, 503, {
          error: "transcribe jobs are not available yet — the cinema module is still starting",
        });
      }

      const status = jobs.start(
        {
          key: p.cacheKey,
          url: p.target,
          engine: p.engine,
          model: p.model,
          lang: p.language ?? "",
          jobId: p.jobId,
        },
        cached,
      );
      server.json(res, 200, { ...status, cached: Boolean(cached) });
    } catch (err) {
      log.error("cinema: transcribe start failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/cinema/media/transcribe/status?key=… — poll a run ───────
  // Cheap and safe to call from any tab at any time. Falls back to the disk
  // cache so a run finished by a previous process still reads as ready.
  server.get("/api/cinema/media/transcribe/status", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const key = (url.searchParams.get("key") ?? "").replace(/[^a-f0-9]/gi, "");
      if (!key || key.length !== 40) {
        return server.json(res, 400, { error: "invalid key (sha1 hex required)" });
      }
      const jobs = getTranscribeJobs?.() ?? null;
      const status = jobs?.status(key) ?? null;
      if (status) return server.json(res, 200, status);

      // No row: either it was never started here, or it finished long ago and
      // the row was pruned. The cache file is the older, stronger evidence.
      const cachePath = path.join(process.cwd(), "data", "subtitles", `${key}.vtt`);
      if (existsSync(cachePath)) {
        const cueCount = parseSubs(await readFile(cachePath, "utf8")).length;
        return server.json(res, 200, { key, status: "ready", frac: 1, cueCount, error: "" });
      }
      server.json(res, 404, { error: "no such job" });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/torrents/transcribe — generate SRT from a video URL ────
  // Returns text/vtt directly (already converted from internal SubCue[]).
  // Cache key: sha1(video_url + engine + model + language).
  //
  // The blocking shape, kept for callers that predate /transcribe/start —
  // and honest about what it is: it holds the socket open for the length of
  // the run, so a proxy read timeout or a restart still loses THIS response.
  // What it no longer loses is the work: the run is a job like any other, so
  // the caller can reconnect with /transcribe/status and collect the result.
  server.get("/api/cinema/media/transcribe", async (req, res) => {
    const jobId = new URL(req.url ?? "/", "http://localhost").searchParams.get("jobId") ?? "";
    try {
      const p = parseTranscribeRequest(req.url ?? "/");
      if (!p.ok) return server.json(res, p.status, { error: p.error });

      if (existsSync(p.cachePath)) {
        const cached = await readFile(p.cachePath, "utf8");
        res.writeHead(200, {
          "content-type": "text/vtt; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=86400",
          "x-transcribe-cache": "hit",
        });
        res.end(cached);
        return;
      }

      const jobs = getTranscribeJobs?.() ?? null;
      let cueCount: number;
      let vtt: string;

      if (jobs) {
        const joined = jobs.isRunning(p.cacheKey);
        if (joined) log.info(`transcribe: joining in-flight ${p.engine}/${p.model} for ${shortUrl(p.target)}`);
        startTranscribeJob(p, null);
        await jobs.join(p.cacheKey);
        const final = jobs.status(p.cacheKey);
        if (final?.status === "error") throw new Error(final.error);
        if (!existsSync(p.cachePath)) {
          throw new Error(final?.error || "transcribe produced no output");
        }
        vtt = await readFile(p.cachePath, "utf8");
        cueCount = final?.cueCount || parseSubs(vtt).length;
        res.writeHead(200, {
          "content-type": "text/vtt; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=86400",
          "x-transcribe-cache": joined ? "join" : "miss",
          "x-transcribe-engine": p.engine,
          "x-transcribe-model": p.model,
          "x-transcribe-cues": String(cueCount),
          "x-transcribe-key": p.cacheKey,
        });
        res.end(vtt);
        return;
      }

      // No job service (module still starting): behave exactly as before,
      // coalescing on the in-memory map.
      const existing = inflightTranscribes.get(p.cacheKey);
      if (existing) {
        log.info(`transcribe: joining in-flight ${p.engine}/${p.model} for ${shortUrl(p.target)}`);
        vtt = await existing;
        cueCount = parseSubs(vtt).length;
      } else {
        const runPromise = runTranscribeToCache(p).then((r) => r.vtt);
        inflightTranscribes.set(p.cacheKey, runPromise);
        try {
          vtt = await runPromise;
          cueCount = parseSubs(vtt).length;
        } finally {
          inflightTranscribes.delete(p.cacheKey);
        }
      }

      res.writeHead(200, {
        "content-type": "text/vtt; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=86400",
        "x-transcribe-cache": existing ? "join" : "miss",
        "x-transcribe-engine": p.engine,
        "x-transcribe-model": p.model,
        "x-transcribe-cues": String(cueCount),
        "x-transcribe-key": p.cacheKey,
      });
      res.end(vtt);
    } catch (err) {
      log.error("torrents: transcribe failed", err);
      publishSubsProgress(jobId, { phase: "transcribe-error", error: extractMessage(err) });
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/torrents/subs/list?url=… — enumerate cached subs ────────
  // Scans <cacheDir>/*.json sidecars, returns those matching the URL.
  // Drives the "USE EXISTING" pill row in the cinema settings popover,
  // so the user can re-pick a previously-generated transcribe / translation
  // without rerunning the pipeline.
  server.get("/api/cinema/media/subs/list", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const target = url.searchParams.get("url") ?? "";
      if (!target) return server.json(res, 400, { error: "url is required" });

      const cacheDir = path.join(process.cwd(), "data", "subtitles");
      if (!existsSync(cacheDir)) return server.json(res, 200, { subs: [] });
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(cacheDir);
      // Restrict listing to <sha1>.json filenames so that an attacker who
      // can drop a symlink in the cache dir can't pivot to ../../etc/passwd
      // via the readFile below. Plain hex 40-char keys are the only legit
      // sidecar shape we ever write.
      const sidecarFiles = entries.filter((f) => /^[a-f0-9]{40}\.json$/i.test(f));
      const subs: SubsSidecar[] = [];
      for (const fname of sidecarFiles) {
        try {
          const raw = await readFile(path.join(cacheDir, fname), "utf8");
          const meta = JSON.parse(raw) as SubsSidecar;
          if (meta?.url !== target) continue;
          // Make sure the .vtt is still on disk (sidecar might out-live it).
          if (!existsSync(path.join(cacheDir, `${meta.key}.vtt`))) continue;
          subs.push(meta);
        } catch { /* skip malformed sidecar */ }
      }
      // Fallback: legacy cache files predating the sidecar feature have
      // no .json companion. Probe known hash combinations for this URL
      // and add any whose .vtt exists. Cheap (5-30 sha1s) and surfaces
      // pre-rebuild generations so users don't have to regenerate.
      const knownKeys = new Set(subs.map((s) => s.key));
      const candidates = enumerateLegacyKeyCandidates(target);
      for (const cand of candidates) {
        if (knownKeys.has(cand.key)) continue;
        if (!existsSync(path.join(cacheDir, `${cand.key}.vtt`))) continue;
        subs.push({
          key: cand.key,
          kind: cand.kind,
          url: target,
          src_lang: cand.src_lang,
          tgt_lang: cand.tgt_lang,
          engine: cand.engine,
          model: cand.model,
          created_at: 0,             // unknown; sort to end
        });
        knownKeys.add(cand.key);
      }

      // Sort: transcribe first (the source), then translations by
      // creation time (newest first; legacy entries with created_at=0
      // sink to the bottom of their group).
      subs.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "transcribe" ? -1 : 1;
        return (b.created_at ?? 0) - (a.created_at ?? 0);
      });
      server.json(res, 200, { subs });
    } catch (err) {
      log.error("torrents: subs list failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/torrents/subs/file/:key.vtt — serve cached sub by key ───
  // Used by the SELECT row to load a cached sub directly without
  // recomputing the parameters. Key is the sha1 returned in the list.
  server.get("/api/cinema/media/subs/file", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const key = (url.searchParams.get("key") ?? "").replace(/[^a-f0-9]/gi, "");
      if (!key || key.length !== 40) {
        return server.json(res, 400, { error: "invalid key (sha1 hex required)" });
      }
      const cachePath = path.join(process.cwd(), "data", "subtitles", `${key}.vtt`);
      if (!existsSync(cachePath)) return server.json(res, 404, { error: "not in cache" });
      const body = await readFile(cachePath, "utf8");
      res.writeHead(200, {
        "content-type": "text/vtt; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=86400",
      });
      res.end(body);
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── DELETE /api/torrents/subs/file?key=… — drop a bad cached sub ──────
  // Removes the <key>.vtt + <key>.json sidecar. Drives the per-sub 🗑 button
  // so the user can delete a mis-transcribed / mis-translated track without
  // touching the rest of the cache. Idempotent: deleting a missing key is ok.
  server.delete("/api/cinema/media/subs/file", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const key = (url.searchParams.get("key") ?? "").replace(/[^a-f0-9]/gi, "");
      if (!key || key.length !== 40) {
        return server.json(res, 400, { error: "invalid key (sha1 hex required)" });
      }
      const cacheDir = path.join(process.cwd(), "data", "subtitles");
      await rmCacheKey(cacheDir, key);
      server.json(res, 200, { ok: true, key });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/torrents/transcribe/cached ─────────────────────────────
  // Cheap probe: is there already a transcribed VTT for this exact
  // (url, engine, model, lang) combo on disk? Returns the existing cache
  // file's metadata (mtime + cue count if cheap) so the cinema page can
  // skip the "generate" button and jump straight to "auto" when the user
  // re-opens a video they previously transcribed. No transcription work.
  //
  // ALSO returns `any: true` if ANY engine/model combo for this URL is
  // cached — lets the UI suggest using the existing one instead of
  // re-running with the current dropdown selection.
  server.get("/api/cinema/media/transcribe/cached", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const target = url.searchParams.get("url") ?? "";
      const engine = (url.searchParams.get("engine") ?? "transformers").toLowerCase();
      const model = url.searchParams.get("model") ?? "base";
      const language = url.searchParams.get("lang") || undefined;
      if (!target) return server.json(res, 400, { error: "url is required" });

      const cacheDir = path.join(process.cwd(), "data", "subtitles");
      const cacheKey = createHash("sha1")
        .update(`transcribe|${target}|${engine}|${model}|${language ?? "auto"}`)
        .digest("hex");
      const cachePath = path.join(cacheDir, `${cacheKey}.vtt`);
      const exact = existsSync(cachePath);

      // Sniff for ANY transcript of this URL across engines/models so the UI
      // can offer "we already have this one" UX. We hash the URL fragment and
      // walk the cache dir matching the prefix component.
      let any = exact;
      let anyKey = exact ? cacheKey : "";
      if (!exact) {
        try {
          const { readdir, stat: statFs } = await import("node:fs/promises");
          const entries = await readdir(cacheDir).catch(() => [] as string[]);
          // We can't reverse the sha1, so the practical fast check is to
          // try the few common engine/model combos.
          const probeCombos: Array<[string, string]> = [
            ["whispercpp", "base"], ["whispercpp", "tiny"], ["whispercpp", "small"],
            ["transformers", "base"], ["transformers", "tiny"],
            ["groq", "base"],
          ];
          for (const [e, m] of probeCombos) {
            const k = createHash("sha1")
              .update(`transcribe|${target}|${e}|${m}|${language ?? "auto"}`)
              .digest("hex");
            if (entries.includes(`${k}.vtt`)) { any = true; anyKey = k; break; }
          }
          // Also try without explicit language ("auto")
          if (!any) {
            for (const [e, m] of probeCombos) {
              const k = createHash("sha1")
                .update(`transcribe|${target}|${e}|${m}|auto`)
                .digest("hex");
              if (entries.includes(`${k}.vtt`)) { any = true; anyKey = k; break; }
            }
          }
          void statFs; // imported in case future caller wants mtime
        } catch { /* ignore — degrade to exact-only signal */ }
      }

      server.json(res, 200, { exact, any, key: anyKey });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/torrents/transcribe/info — engine availability ─────────
  // whispercpp used to be hardcoded `available: true`, so the picker offered
  // an engine that could not run and the user found out only when the job
  // failed. It is now probed (cached 60s in media-tools), and reports the
  // install command for the host when it is missing.
  server.get("/api/cinema/media/transcribe/info", async (_req, res) => {
    const whisper = await probeMediaTool("whisper-cli");
    const ffmpeg = await probeMediaTool("ffmpeg");
    server.json(res, 200, {
      engines: {
        // Runs in-process via @huggingface/transformers — no external binary,
        // which is why this one is genuinely always available.
        transformers: { available: true, model: "Xenova/whisper-base", offline: true, hint: "10-20 min for 90min film, no setup" },
        whispercpp: {
          available: whisper.available,
          version: whisper.version,
          hint: whisper.available
            ? "3-8 min for 90min film"
            : `${whisper.reason}. ${whisper.hint}`,
        },
        groq: { available: isGroqWhisperAvailable(), model: process.env.GROQ_WHISPER_MODEL ?? "whisper-large-v3", hint: "30s for 90min film via Groq Cloud API" },
      },
      // Every offline engine extracts its audio with ffmpeg first, so without
      // it only Groq (which uploads the source URL) can run at all.
      ffmpeg: {
        available: ffmpeg.available,
        version: ffmpeg.version,
        hint: ffmpeg.available ? undefined : `${ffmpeg.reason}. ${ffmpeg.hint}`,
      },
      models: ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"],
    });
  });

  // ── GET /api/torrents/translate-srt/info — engine availability ──────
  // Returns the two distinct subtitle-translation paths:
  //   - nllb: offline NLLB-200 (always available, slow ~10 min for a film)
  //   - llm:  the LlmClient chain configured at /models — every cloud /
  //           local-LLM provider routes through it, so this exposes the
  //           ordered chain (primary + fallbacks) and which links have
  //           credentials. The cinema/MediaPlayer pickers use this to
  //           render the engine tile + a chain summary.
  server.get("/api/cinema/media/translate-srt/info", async (_req, res) => {
    const chain = llm().describeChain();
    server.json(res, 200, {
      engines: {
        nllb: { available: true, model: "Xenova/nllb-200-distilled-600M", offline: true },
        llm: {
          available: chain.primary.available || chain.fallbacks.some(f => f.available),
          primary: chain.primary,
          fallbacks: chain.fallbacks,
        },
      },
      languages: ["en", "es", "pt", "fr", "de", "it", "ja", "zh", "ru", "ko", "ar"]
        .map(iso => ({ iso, name: langName(iso) })),
    });
  });

  // ── GET /api/torrents/inbox?target= — drain pending notifications ─
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}


// ── archive.org search ──────────────────────────────────────────────────
export interface ImportArchiveQuery {
  collection?: string;       // e.g. "feature_films", "silent_films"
  query?: string;            // free-text on title/creator/subject
  year_min?: number;         // filter by year (date >= YYYY-01-01)
  year_max?: number;
  mediatype?: string;        // default "movies"
  rows?: number;             // default 50, max 500
  page?: number;             // 1-based
}

export interface ArchiveSearchItem {
  identifier: string;
  title: string;
  date?: string;
  creator?: string;
  description?: string;
  subject?: string[];
  collection?: string[];
  downloads?: number;
}

/** Cache TTL for archive.org search results — 6h matches the /cinema UI. */
export const ARCHIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Deterministic cache key for an archive.org search. Normalizes the params so
 * `{collection:"x"}` and `{collection:"x", query:undefined}` collapse to the
 * same key.
 */
export function archiveCacheKey(q: ImportArchiveQuery): string {
  const norm = {
    collection: q.collection ?? "",
    query: (q.query ?? "").trim(),
    year_min: q.year_min ?? 0,
    year_max: q.year_max ?? 0,
    mediatype: q.mediatype ?? "movies",
    rows: q.rows ?? 50,
    page: q.page ?? 1,
  };
  return createHash("sha1").update(JSON.stringify(norm)).digest("hex");
}

export async function searchArchive(q: ImportArchiveQuery): Promise<ArchiveSearchItem[]> {
  const filters: string[] = [];
  filters.push(`mediatype:${q.mediatype || "movies"}`);
  if (q.collection) filters.push(`collection:${q.collection}`);
  if (q.year_min || q.year_max) {
    const lo = q.year_min ? `${q.year_min}-01-01` : "*";
    const hi = q.year_max ? `${q.year_max}-12-31` : "*";
    filters.push(`date:[${lo} TO ${hi}]`);
  }
  if (q.query?.trim()) filters.push(`(${q.query.trim()})`);
  // Only items that ship a .torrent. The Archive Bittorrent format flag
  // is the cleanest filter — items with seedable torrents.
  filters.push(`format:"Archive BitTorrent"`);

  const rows = Math.min(Math.max(q.rows ?? 50, 1), 500);
  const page = Math.max(q.page ?? 1, 1);
  const params = new URLSearchParams();
  params.set("q", filters.join(" AND "));
  for (const f of ["identifier", "title", "date", "creator", "description", "subject", "collection", "downloads"]) {
    params.append("fl[]", f);
  }
  params.append("sort[]", "downloads desc");
  params.set("output", "json");
  params.set("rows", String(rows));
  params.set("page", String(page));

  const url = `https://archive.org/advancedsearch.php?${params.toString()}`;
  const r = await fetch(url, {
    headers: { "user-agent": "Kernl/archive-importer" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`archive.org search ${r.status}`);
  const body = (await r.json()) as {
    response?: { docs?: Array<Record<string, unknown>> };
  };
  const docs = body.response?.docs ?? [];
  return docs.map((d) => ({
    identifier: String(d.identifier ?? ""),
    title: typeof d.title === "string" ? d.title : Array.isArray(d.title) ? d.title.join(" / ") : String(d.title ?? ""),
    date: typeof d.date === "string" ? d.date : undefined,
    creator: typeof d.creator === "string" ? d.creator : Array.isArray(d.creator) ? d.creator.join(", ") : undefined,
    description: typeof d.description === "string" ? d.description : Array.isArray(d.description) ? d.description.join(" ") : undefined,
    subject: Array.isArray(d.subject) ? d.subject.map(String) : typeof d.subject === "string" ? [d.subject] : undefined,
    collection: Array.isArray(d.collection) ? d.collection.map(String) : typeof d.collection === "string" ? [d.collection] : undefined,
    downloads: typeof d.downloads === "number" ? d.downloads : undefined,
  })).filter(x => x.identifier);
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

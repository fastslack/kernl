/**
 * Speech-to-text engines: whisper.cpp (offline binary), Whisper transformers
 * (offline ONNX), Groq Cloud (API). Each implements `transcribe(url, opts)`
 * → SubCue[]. The endpoint picks the engine via `?engine=` param.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { log } from "../../../../../src/core/logger.js";
import { mediaToolError, probeMediaTool } from "../../../../../src/core/media-tools.js";
import {
  parseBackendLog,
  pickBackend,
  recordObservedBackends,
} from "../../../../../src/core/compute-backend.js";
import type { SubCue } from "./subtitles.js";
import { parseSubs, dropRepeatRuns } from "./subtitles.js";

export type TranscribeEngine = "whispercpp" | "transformers" | "groq";

/**
 * Sub-phases the UI surfaces during a transcribe run. Each one has its own
 * (frac, processedSec, totalSec) so the progress bar can show:
 *   - "Probing duration…"        (probe, instant — usually skipped)
 *   - "Downloading audio (12s of 5m24s)"   (extract — ffmpeg)
 *   - "Downloading model (40 MB)…"         (load-model — one-time per model)
 *   - "Transcribing (47%)"       (transcribe — whisper itself)
 *
 * `frac` is 0..1 for the CURRENT sub-phase. processedSec / totalSec are
 * audio-seconds (for extract and transcribe) — the UI computes ×realtime
 * rate from those + wall-clock elapsed.
 */
export interface TranscribeProgress {
  subPhase: "probe" | "extract" | "load-model" | "transcribe";
  frac: number;
  /** Audio seconds processed (extract/transcribe). Omit when meaningless. */
  processedSec?: number;
  /** Audio seconds total (extract/transcribe), or MB total (load-model). */
  totalSec?: number;
  /** Free-text hint shown under the bar — e.g. model name being downloaded. */
  hint?: string;
}

export interface TranscribeOpts {
  /** ISO-639-1 hint, e.g. "en". Empty = auto-detect (slower). */
  language?: string;
  /** Whisper model size. Affects all engines. */
  /** `large-v3-turbo` is the one to reach for on a GPU: roughly six times
   *  faster than large-v3 for one to two points of accuracy, and accurate
   *  enough that the repetition loop `-mc 0` and `-sns` exist to contain
   *  stops happening on old, music-heavy prints. */
  model?: "tiny" | "base" | "small" | "medium" | "large-v3" | "large-v3-turbo";
  /** Optional progress callback — fires as each sub-phase advances. */
  onProgress?: (p: TranscribeProgress) => void;
  signal?: AbortSignal;
}

const DEFAULT_MODEL = "base"; // tiny is too weak for old / noisy recordings
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";

// ── Audio extraction (shared by all offline engines) ─────────────────────

/**
 * Stream a video/audio URL through ffmpeg → temp WAV file (16kHz mono s16le).
 * Returns the file path; caller must delete it.
 *
 * Routes external http(s) URLs through our local /api/cinema/media/webseed-proxy
 * because ffmpeg's libavformat HTTP client trips on archive.org's SSL/302
 * redirect chain (returns 5XX). Our proxy already handles UA, redirects,
 * and Range correctly — and ffmpeg connecting to localhost is bulletproof.
 */
export interface ExtractOpts {
  /** Total duration of the source in seconds — when known, lets us compute
   *  a real extract-phase progress fraction. When omitted, ffmpeg still
   *  reports out_time but the bar stays indeterminate. */
  totalSec?: number;
  /** Per-tick callback fired as ffmpeg processes audio. */
  onProgress?: (p: { processedSec: number; totalSec?: number; frac?: number }) => void;
}

export async function extractAudioToWav(url: string, opts: ExtractOpts = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mtw-transcribe-"));
  const out = path.join(dir, "audio.wav");
  const inputUrl = wrapThroughProxy(url);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, [
      "-hide_banner", "-loglevel", "error",
      "-user_agent", "Kernl/transcribe",
      "-headers", "Accept: */*\r\n",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-i", inputUrl,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      // loudnorm normalizes weak sources (old films often mastered around
      // -50 dB, well below Whisper's recognition threshold) to ~-16 LUFS,
      // and the high/low-pass narrows to speech band so amplified noise
      // doesn't get hallucinated as ambient sound.
      "-af", "loudnorm=I=-16:LRA=11:TP=-1.5,highpass=f=80,lowpass=f=4000",
      // Machine-readable progress on stdout: ffmpeg writes key=value lines
      // ("out_time_us=12345000\n…") every 500ms. Separate stream from
      // -loglevel error stderr so we don't have to grep through warnings.
      "-progress", "pipe:1",
      "-nostats",
      "-f", "wav",
      out,
    ]);
    let err = "";
    let progressBuf = "";
    ff.stdout?.on("data", (b: Buffer) => {
      progressBuf += b.toString();
      // ffmpeg emits a `progress=continue\n` (or `=end`) sentinel after
      // each tick — split on it so we process complete tick frames.
      let nl: number;
      while ((nl = progressBuf.indexOf("progress=")) !== -1) {
        const tickEnd = progressBuf.indexOf("\n", nl);
        if (tickEnd === -1) break;
        const tick = progressBuf.slice(0, tickEnd);
        progressBuf = progressBuf.slice(tickEnd + 1);
        const m = /out_time_us=(\d+)/.exec(tick) ?? /out_time_ms=(\d+)/.exec(tick);
        if (m && opts.onProgress) {
          // out_time_us is microseconds; out_time_ms is also microseconds
          // (yes, ffmpeg's key is misleading — it's μs in both cases).
          const processedSec = Number(m[1]) / 1_000_000;
          const totalSec = opts.totalSec;
          const frac = totalSec && totalSec > 0
            ? Math.min(0.99, processedSec / totalSec)
            : undefined;
          opts.onProgress({ processedSec, totalSec, frac });
        }
      }
    });
    ff.stderr?.on("data", (b: Buffer) => { err += b.toString(); });
    // A spawn failure here is almost always "ffmpeg is not installed" — the
    // native macOS and Windows builds bundle the runtime only. Raw ENOENT
    // reached the user as "spawn ffmpeg ENOENT", which names the problem
    // without naming the fix.
    ff.on("error", (e) => reject(mediaToolError("ffmpeg", e)));
    ff.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 200)}`));
    });
  });
  return out;
}

/**
 * Quick ffprobe call to discover the upstream duration so the extract phase
 * has a denominator. Returns null on failure — caller can still run extract,
 * just without a frac. 5s cap so a slow CDN doesn't stall the transcribe
 * start.
 */
async function probeUpstreamDuration(url: string): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const probe = spawn("ffprobe", [
      "-v", "error",
      "-user_agent", "Kernl/transcribe",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      wrapThroughProxy(url),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    probe.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
    const killer = setTimeout(() => { try { probe.kill("SIGTERM"); } catch { /* */ } }, 5000);
    probe.on("exit", () => {
      clearTimeout(killer);
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
    probe.on("error", () => { clearTimeout(killer); resolve(null); });
  });
}

/**
 * Wrap a remote http(s) URL with our local webseed proxy. The kernel listens
 * on $DASHBOARD_PORT (default 3086). ffmpeg can't send an Authorization
 * header, so we append the auth token as `?auth=<token>` — src/core/auth.ts
 * accepts that query-string fallback specifically for non-fetch clients.
 */
function wrapThroughProxy(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  // Already proxied? leave it.
  if (url.includes("/api/cinema/media/webseed-proxy?")) return url;
  const port = process.env.DASHBOARD_PORT ?? process.env.KERNEL_HTTP_PORT ?? "3086";
  const token = process.env.KERNEL_AUTH_TOKEN ?? "";

  // Internal kernel stream URL (our own /api/torrents/:id/file/:idx/stream).
  // ffmpeg runs INSIDE the kernel container, so the browser-origin host the
  // UI baked in (e.g. 127.0.0.1:3086 = the dashboard nginx, a different
  // container) is unreachable, and routing it through the webseed-proxy would
  // trip the proxy's SSRF guard on loopback anyway. Point ffmpeg straight at
  // the kernel's own loopback stream endpoint, carrying the auth token as a
  // query param (ffmpeg can't send an Authorization header).
  if (/\/api\/torrents\/[^/]+\/file\/\d+\/stream/.test(url)) {
    try {
      const u = new URL(url);
      u.protocol = "http:";
      u.hostname = "127.0.0.1";
      u.port = port;
      if (token && !u.searchParams.has("auth")) u.searchParams.set("auth", token);
      return u.toString();
    } catch {
      /* malformed — fall through to the generic proxy path */
    }
  }

  const authParam = token ? `&auth=${encodeURIComponent(token)}` : "";
  return `http://127.0.0.1:${port}/api/cinema/media/webseed-proxy?url=${encodeURIComponent(url)}${authParam}`;
}

async function rmDirOf(filePath: string): Promise<void> {
  try { await rm(path.dirname(filePath), { recursive: true, force: true }); }
  catch { /* */ }
}

// ── whisper.cpp engine ──────────────────────────────────────────────────

const WHISPERCPP_BIN = process.env.WHISPERCPP_BIN ?? "whisper-cli";
const WHISPERCPP_MODELS_DIR =
  process.env.WHISPERCPP_MODELS_DIR ?? path.join(process.cwd(), "data", "whisper-models");

function ggmlUrl(model: string): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
}

async function ensureGgmlModel(
  model: string,
  onProgress?: (p: { downloadedMB: number; totalMB?: number; frac?: number }) => void,
): Promise<string> {
  const target = path.join(WHISPERCPP_MODELS_DIR, `ggml-${model}.bin`);
  if (existsSync(target)) return target;
  log.info(`Downloading ggml-${model}.bin … (one-time)`);
  const r = await fetch(ggmlUrl(model));
  if (!r.ok) throw new Error(`ggml download ${r.status}`);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(WHISPERCPP_MODELS_DIR, { recursive: true });
  // Stream the download so we can emit progress instead of waiting for the
  // whole file to land. Falls back to arrayBuffer() if the response has no
  // readable body (shouldn't happen with HF, defensive).
  const totalBytesRaw = r.headers.get("content-length");
  const totalBytes = totalBytesRaw ? parseInt(totalBytesRaw, 10) : 0;
  const totalMB = totalBytes ? totalBytes / (1024 * 1024) : undefined;
  if (!r.body) {
    const buf = Buffer.from(await r.arrayBuffer());
    await writeFile(target, buf);
    log.info(`ggml-${model}.bin saved (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
    return target;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = r.body.getReader();
  // Throttle progress callbacks to ~10 Hz so we don't drown the SSE channel.
  let lastEmit = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const now = Date.now();
    if (onProgress && now - lastEmit > 100) {
      lastEmit = now;
      const downloadedMB = received / (1024 * 1024);
      const frac = totalBytes ? Math.min(0.99, received / totalBytes) : undefined;
      onProgress({ downloadedMB, totalMB, frac });
    }
  }
  const buf = Buffer.concat(chunks);
  await writeFile(target, buf);
  if (onProgress) {
    onProgress({ downloadedMB: buf.length / (1024 * 1024), totalMB, frac: 1 });
  }
  log.info(`ggml-${model}.bin saved (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  return target;
}

export function isWhisperCppAvailable(): boolean {
  // We can't easily check the binary without spawn; rely on env or PATH.
  // The endpoint surfaces a clear error if invocation fails.
  return Boolean(process.env.WHISPERCPP_BIN) || true; // optimistic — endpoint catches missing binary
}

async function transcribeWhisperCpp(url: string, opts: TranscribeOpts): Promise<SubCue[]> {
  const model = opts.model ?? DEFAULT_MODEL;
  const emit = opts.onProgress;

  // ── Sub-phase 1: model download (one-time, skipped when cached) ─────
  emit?.({ subPhase: "load-model", frac: 0, hint: `ggml-${model}.bin` });
  const modelPath = await ensureGgmlModel(model, (p) => {
    emit?.({
      subPhase: "load-model",
      frac: p.frac ?? 0,
      processedSec: p.downloadedMB,
      totalSec: p.totalMB,
      hint: `ggml-${model}.bin`,
    });
  });
  emit?.({ subPhase: "load-model", frac: 1, hint: `ggml-${model}.bin` });

  // ── Sub-phase 2: probe duration so the extract bar has a denominator ─
  emit?.({ subPhase: "probe", frac: 0 });
  const probedSec = await probeUpstreamDuration(url);
  emit?.({ subPhase: "probe", frac: 1, totalSec: probedSec ?? undefined });

  // ── Sub-phase 3: ffmpeg extracts the audio ──────────────────────────
  emit?.({
    subPhase: "extract",
    frac: 0,
    totalSec: probedSec ?? undefined,
    hint: "ffmpeg",
  });
  const wav = await extractAudioToWav(url, {
    totalSec: probedSec ?? undefined,
    onProgress: (p) => {
      emit?.({
        subPhase: "extract",
        frac: p.frac ?? 0,
        processedSec: p.processedSec,
        totalSec: p.totalSec,
        hint: "ffmpeg",
      });
    },
  });
  emit?.({
    subPhase: "extract",
    frac: 1,
    processedSec: probedSec ?? undefined,
    totalSec: probedSec ?? undefined,
    hint: "ffmpeg",
  });

  try {
    const args = [
      "-m", modelPath,
      "-f", wav,
      "-osrt",                          // emit .srt next to the wav
      "-of", wav,                       // base output name (no extension)
      "-t", "4",                        // threads
      "-pp",                            // print progress (whisper.cpp writes to stderr)
      // ── Anti-hallucination ───────────────────────────────────────────
      // Without these, whisper.cpp on noisy / music-heavy old films gets
      // stuck in a repetition loop: it emits "[Music]" once over the intro
      // score, then — because the default -mc -1 carries unlimited decoded
      // text as context into every later 30s window — it keeps predicting
      // "[Music]" for the rest of the reel. (Real symptom: The Time
      // Travelers 1964 → 266 consecutive "[Music]" cues, no dialogue until
      // 01:03.) -mc 0 resets context per window so each is transcribed
      // independently; -sns drops "[Music]"/"[Applause]" non-speech tokens
      // entirely so a noisy soundtrack can't crowd out the dialogue.
      "-mc", "0",
      "-sns",
    ];
    if (opts.language) args.push("-l", opts.language);

    // ── Sub-phase 4: whisper.cpp transcribes ───────────────────────────
    emit?.({ subPhase: "transcribe", frac: 0, totalSec: probedSec ?? undefined });
    await new Promise<void>((resolve, reject) => {
      const proc: ChildProcess = spawn(WHISPERCPP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      // Which backend actually ran, surfaced in the same one-word slot the
      // extract phase uses for "ffmpeg". ggml announces this once at startup,
      // before any audio is processed:
      //
      //   load_backend: loaded CUDA backend from …/libggml-cuda.so
      //   load_backend: loaded CPU backend from …/libggml-cpu-zen4.so
      //
      // Worth showing because the alternative is invisible: a GPU library
      // that fails to load is skipped silently, and the only symptom is that
      // a film takes half an hour instead of a minute. "cpu" sitting under
      // the progress bar on a machine with a graphics card is a bug report
      // the user can file without knowing any of this.
      let backendHint = "";
      // whisper.cpp's -pp lines are written to STDERR (not stdout) — the
      // previous code grepped the wrong stream, which is why the bar always
      // stayed at 0% and fell through to the wall-clock estimate.
      const handleProgressChunk = (s: string) => {
        const matches = s.matchAll(/progress\s*=\s*(\d{1,3})%/g);
        for (const m of matches) {
          const pct = Math.min(99, Number(m[1]));
          if (emit) {
            const frac = pct / 100;
            const processedSec = probedSec ? probedSec * frac : undefined;
            emit({
              subPhase: "transcribe",
              frac,
              processedSec,
              totalSec: probedSec ?? undefined,
              hint: backendHint || undefined,
            });
          }
        }
      };
      proc.stdout?.on("data", (b: Buffer) => { handleProgressChunk(b.toString()); });
      proc.stderr?.on("data", (b: Buffer) => {
        const chunk = b.toString();
        stderr += chunk;
        // Parse against the accumulated buffer, not the chunk: the backend
        // lines arrive early and can be split across reads. Only resolve once
        // — after that `backendHint` is set and this is a cheap string test.
        if (!backendHint) {
          const seen = parseBackendLog(stderr);
          if (seen.backends.length > 0) {
            backendHint = pickBackend(seen.backends);
            recordObservedBackends(stderr);
            log.info(`whisper.cpp running on ${backendHint}`);
            emit?.({
              subPhase: "transcribe",
              frac: 0,
              totalSec: probedSec ?? undefined,
              hint: backendHint,
            });
          }
        }
        handleProgressChunk(chunk);
      });
      proc.on("error", (e) => reject(mediaToolError("whisper-cli", e)));
      proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`whisper-cli exited ${code}: ${stderr.slice(0, 200)}`)));
    });
    emit?.({
      subPhase: "transcribe",
      frac: 1,
      processedSec: probedSec ?? undefined,
      totalSec: probedSec ?? undefined,
    });

    const srtPath = `${wav}.srt`;
    if (!existsSync(srtPath)) throw new Error("whisper.cpp produced no .srt");
    const { readFile } = await import("node:fs/promises");
    const srt = await readFile(srtPath, "utf8");
    return parseSubs(srt);
  } finally {
    await rmDirOf(wav);
  }
}

// ── Whisper transformers engine (Xenova/whisper-*) ──────────────────────

let whisperPipeline: any | null = null;
let whisperLoading: Promise<any> | null = null;

async function getWhisperPipeline(model: string) {
  if (whisperPipeline?.__model === `Xenova/whisper-${model}`) return whisperPipeline;
  if (whisperLoading) return whisperLoading;
  log.info(`Loading Xenova/whisper-${model} (first call may download model)`);
  whisperLoading = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    const p = await pipeline("automatic-speech-recognition", `Xenova/whisper-${model}`, { dtype: "fp32" });
    (p as any).__model = `Xenova/whisper-${model}`;
    whisperPipeline = p;
    return p;
  })();
  return whisperLoading;
}

async function decodeWavToFloat32(wavPath: string): Promise<Float32Array> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(wavPath);
  // Minimal WAV parser: assume PCM s16le mono 16kHz (we generated it).
  // RIFF header is 44 bytes; find "data" chunk to be safe.
  let off = 12;
  while (off < raw.length - 8) {
    const id = raw.slice(off, off + 4).toString("ascii");
    const size = raw.readUInt32LE(off + 4);
    if (id === "data") {
      const start = off + 8;
      const end = start + size;
      const samples = (end - start) / 2;
      const out = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        out[i] = raw.readInt16LE(start + i * 2) / 0x8000;
      }
      return out;
    }
    off += 8 + size;
  }
  throw new Error("no data chunk in wav");
}

async function transcribeTransformers(url: string, opts: TranscribeOpts): Promise<SubCue[]> {
  const emit = opts.onProgress;
  emit?.({ subPhase: "probe", frac: 0 });
  const probedSec = await probeUpstreamDuration(url);
  emit?.({ subPhase: "probe", frac: 1, totalSec: probedSec ?? undefined });
  emit?.({ subPhase: "extract", frac: 0, totalSec: probedSec ?? undefined, hint: "ffmpeg" });
  const wav = await extractAudioToWav(url, {
    totalSec: probedSec ?? undefined,
    onProgress: (p) => emit?.({
      subPhase: "extract",
      frac: p.frac ?? 0,
      processedSec: p.processedSec,
      totalSec: p.totalSec,
      hint: "ffmpeg",
    }),
  });
  emit?.({ subPhase: "extract", frac: 1, processedSec: probedSec ?? undefined, totalSec: probedSec ?? undefined, hint: "ffmpeg" });
  try {
    emit?.({ subPhase: "transcribe", frac: 0, totalSec: probedSec ?? undefined });
    const pipe = await getWhisperPipeline(opts.model ?? DEFAULT_MODEL);
    const samples = await decodeWavToFloat32(wav);
    const result = await pipe(samples, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      language: opts.language,
      task: "transcribe",
    });
    // result: { text, chunks: [{ text, timestamp: [start, end] }] }
    const chunks = (result as any).chunks ?? [];
    const cues: SubCue[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const [s, e] = c.timestamp ?? [0, 0];
      const text = (c.text ?? "").trim();
      if (!text) continue;
      cues.push({
        index: cues.length + 1,
        start: typeof s === "number" ? s : 0,
        end: typeof e === "number" && e > s ? e : (typeof s === "number" ? s + 2 : 2),
        text,
      });
    }
    return cues;
  } finally {
    await rmDirOf(wav);
  }
}

// ── Groq Cloud Whisper engine ───────────────────────────────────────────

const GROQ_ENDPOINT =
  process.env.GROQ_API_URL ?? "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = process.env.GROQ_WHISPER_MODEL ?? "whisper-large-v3";

export function isGroqAvailable(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

async function transcribeGroq(url: string, opts: TranscribeOpts): Promise<SubCue[]> {
  if (!isGroqAvailable()) throw new Error("GROQ_API_KEY not set");
  const emit = opts.onProgress;
  emit?.({ subPhase: "probe", frac: 0 });
  const probedSec = await probeUpstreamDuration(url);
  emit?.({ subPhase: "probe", frac: 1, totalSec: probedSec ?? undefined });
  emit?.({ subPhase: "extract", frac: 0, totalSec: probedSec ?? undefined, hint: "ffmpeg" });
  const wav = await extractAudioToWav(url, {
    totalSec: probedSec ?? undefined,
    onProgress: (p) => emit?.({
      subPhase: "extract",
      frac: p.frac ?? 0,
      processedSec: p.processedSec,
      totalSec: p.totalSec,
      hint: "ffmpeg",
    }),
  });
  emit?.({ subPhase: "extract", frac: 1, processedSec: probedSec ?? undefined, totalSec: probedSec ?? undefined, hint: "ffmpeg" });
  emit?.({ subPhase: "transcribe", frac: 0, totalSec: probedSec ?? undefined });
  try {
    const { readFile } = await import("node:fs/promises");
    const audio = await readFile(wav);
    const fd = new FormData();
    fd.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
    fd.append("model", GROQ_MODEL);
    fd.append("response_format", "verbose_json");
    fd.append("timestamp_granularities[]", "segment");
    if (opts.language) fd.append("language", opts.language);

    const r = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: fd,
      signal: opts.signal,
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`groq ${r.status}: ${t.slice(0, 200)}`);
    }
    const json = await r.json() as { segments?: Array<{ start: number; end: number; text: string }> };
    return (json.segments ?? []).map((s, i) => ({
      index: i + 1,
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));
  } finally {
    await rmDirOf(wav);
  }
}

// ── Public dispatcher ───────────────────────────────────────────────────

export async function transcribe(
  engine: TranscribeEngine,
  url: string,
  opts: TranscribeOpts = {},
): Promise<SubCue[]> {
  let cues: SubCue[];
  switch (engine) {
    case "whispercpp": cues = await transcribeWhisperCpp(url, opts); break;
    case "transformers": cues = await transcribeTransformers(url, opts); break;
    case "groq": cues = await transcribeGroq(url, opts); break;
    default: throw new Error(`unknown engine: ${engine}`);
  }
  // Backstop against repetition-loop hallucinations regardless of engine.
  return dropRepeatRuns(cues);
}

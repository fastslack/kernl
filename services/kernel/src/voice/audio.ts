/**
 * The two ffmpeg conversions the voice module needs.
 *
 * In: whatever a browser's MediaRecorder or Telegram hands us (webm/opus,
 * ogg/opus, mp4/aac on Safari) → 16 kHz mono PCM WAV, the only input
 * whisper.cpp reads. Out: Piper's WAV → ogg/opus, which Telegram requires for
 * a voice note and which every browser plays at a tenth of WAV's size.
 *
 * Both go through stdin/stdout so nothing but the WAV whisper needs on disk
 * ever touches it.
 */

import { spawn } from "node:child_process";
import { mediaToolBin, mediaToolError } from "../core/media-tools.js";

const FFMPEG_TIMEOUT_MS = 60_000;

function runFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(mediaToolBin("ffmpeg"), ["-hide_banner", "-loglevel", "error", ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(mediaToolError("ffmpeg", err));
      return;
    }
    const out: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", (err) => { clearTimeout(timer); reject(mediaToolError("ffmpeg", err)); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
    // EPIPE when ffmpeg rejects the input early — the close handler reports it.
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
  });
}

/** Any audio container → 16 kHz mono s16le WAV bytes. */
export function toWav16k(input: Buffer): Promise<Buffer> {
  // -bitexact / -map_metadata -1: no LIST chunk, so the header is the plain
  // 44 bytes the two readers below assume.
  return runFfmpeg([
    "-i", "pipe:0", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1",
  ], input);
}

/** Seconds of audio in a 16 kHz mono s16le WAV (44-byte header). */
export function wav16kSeconds(wav: Buffer): number {
  return Math.max(0, wav.length - 44) / (16_000 * 2);
}

/** What a recording sounds like, in numbers. All levels in dBFS (0 = full scale). */
export interface AudioLevels {
  seconds: number;
  /** Loudest sample. */
  peakDb: number;
  /** Loud end of the voice: the 90th percentile of 30 ms frame RMS. */
  speechDb: number;
  /** Background between words: the 10th percentile of frame RMS. */
  noiseDb: number;
  /** speechDb − noiseDb. Under ~15 dB whisper starts guessing. */
  snrDb: number;
  /** 30 ms frames clearly above the background — see `measureLevels`. */
  voicedFrames: number;
  /** Share of samples at or near full scale (distortion). */
  clippedPct: number;
}

const FRAME = 480; // 30 ms at 16 kHz
const toDb = (rms: number) => (rms <= 0 ? -96 : Math.max(-96, 20 * Math.log10(rms / 32768)));

/**
 * Measure a 16 kHz mono s16le WAV (44-byte header).
 *
 * The voiced-frame count is what keeps silence away from whisper, which does
 * not answer nothing with nothing: fed silence it writes "Subtítulos por la
 * Iglesia de Jesucristo…", fed room noise "¡Suscríbete!". A frame counts as
 * voiced when it is well above the recording's own background (3.5× its
 * 10th-percentile RMS, ≈ 11 dB) and above an absolute floor of RMS 12
 * (≈ −69 dBFS). The floor was RMS 60 until a real mic arrived at −54 dBFS
 * over a −86 dBFS room: SNR 30 dB, perfectly usable, and only 7 frames
 * counted. Relative on purpose: a fixed RMS 500 threshold, calibrated on
 * a synthetic voice at full level, threw away a real 3.7 s message from a
 * quiet laptop mic. Measured: a spoken sentence has well over 100 voiced
 * frames; two seconds of digital silence and of pink room noise have 1 each
 * (the resampler's click at the start).
 */
export function measureLevels(wav: Buffer): AudioLevels {
  const samples = Math.floor(Math.max(0, wav.length - 44) / 2);
  const rms: number[] = [];
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i + FRAME <= samples; i += FRAME) {
    let sum = 0;
    for (let j = 0; j < FRAME; j++) {
      const v = wav.readInt16LE(44 + 2 * (i + j));
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= 32000) clipped++;
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / FRAME));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const pct = (q: number) => (sorted.length ? sorted[Math.floor(q * (sorted.length - 1))] : 0);
  const noise = pct(0.1);
  const speech = pct(0.9);
  const threshold = Math.max(12, noise * 3.5);
  return {
    seconds: samples / 16_000,
    peakDb: Math.round(toDb(peak)),
    speechDb: Math.round(toDb(speech)),
    noiseDb: Math.round(toDb(noise)),
    snrDb: Math.round(toDb(speech) - toDb(noise)),
    voicedFrames: rms.filter((r) => r > threshold).length,
    clippedPct: samples ? Math.round((clipped / samples) * 1000) / 10 : 0,
  };
}

/** Kept for callers that only need the count. */
export function voicedFrames(wav: Buffer): number {
  return measureLevels(wav).voicedFrames;
}

/** WAV → the delivery format. */
export function encodeWav(wav: Buffer, format: "ogg" | "mp3" | "wav"): Promise<Buffer> {
  if (format === "wav") return Promise.resolve(wav);
  const codec = format === "ogg"
    ? ["-c:a", "libopus", "-b:a", "32k", "-f", "ogg"]
    : ["-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3"];
  return runFfmpeg(["-f", "wav", "-i", "pipe:0", ...codec, "pipe:1"], wav);
}

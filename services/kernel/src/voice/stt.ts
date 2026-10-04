/**
 * Speech-to-text.
 *
 * Three engines behind one call. whisper.cpp runs locally on the binary Kernl
 * already ships for Cinema and reuses its models; Groq and OpenAI are the
 * cloud fallbacks for a machine without it. `auto` walks them in that order
 * and keeps going past an engine that fails, so a missing binary or an
 * expired key costs a slower answer rather than no answer.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { log } from "../core/logger.js";
import { getProviderConfig } from "../core/llm/credentials.js";
import { mediaToolBin, mediaToolError } from "../core/media-tools.js";
import { probeComputeBackend, recordObservedBackends } from "../core/compute-backend.js";
import { measureLevels, toWav16k, wav16kSeconds, type AudioLevels } from "./audio.js";
import { ensureWhisperModel, whisperModelsDir } from "./downloads.js";
import { cleanTranscript } from "./text.js";
import type { SttEngine, TranscribeOptions, TranscriptionResult, VoiceSettings } from "./types.js";

/** Shorter than this is a mis-press, not speech. */
export const MIN_SPEECH_SECONDS = 0.3;
/** One utterance, not a dictation session: keeps a stuck mic from queueing minutes of whisper. */
export const MAX_SPEECH_SECONDS = 120;

/** 150 ms of voice-level audio; less is a press with nothing said. */
export const MIN_VOICED_FRAMES = 5;

/**
 * Context handed to whisper when the caller gives none. It names the words a
 * generic model gets wrong here — measured on whisper `small`: without it
 * "Hola, soy el Chief" came back "Palazzo el chef" — and sets the register
 * (voseo) so "armame" is not heard as "tearme".
 */
const DEFAULT_PROMPTS: Record<string, string> = {
  es: "Conversación con el Chief, el asistente de Kernl. ¿Qué tenés para hoy? Armame la agenda.",
  en: "A conversation with the Chief, Kernl's assistant. What's on for today? Set up my agenda.",
};

const AUTO_ORDER: SttEngine[] = ["whispercpp", "groq", "openai"];

/** The engines `setting` stands for, in the order to try them. */
export function sttChain(setting: VoiceSettings["sttEngine"]): SttEngine[] {
  return setting === "auto" ? AUTO_ORDER : [setting];
}

export function isCloudSttConfigured(engine: SttEngine): boolean {
  if (engine === "groq") return getProviderConfig("groq").apiKey !== "";
  if (engine === "openai") return getProviderConfig("openai").apiKey !== "";
  return true;
}

/**
 * The whisper model for this machine when the setting leaves it open: the
 * turbo model wherever there is a GPU (it answers a sentence in well under a
 * second there), `small` on CPU — `base` is fast but mangles Spanish.
 */
export async function pickWhisperModel(settings: VoiceSettings): Promise<string> {
  if (settings.whisperModel.trim()) return settings.whisperModel.trim();
  const caps = await probeComputeBackend(mediaToolBin("whisper-cli"));
  return caps.backend === "cpu" ? "small" : "large-v3-turbo";
}

/** One log line a person can read: "3.2s · voz −31 dBFS · ruido −58 · SNR 27 dB · pico −12 · 61 tramos". */
export function describeLevels(l: AudioLevels): string {
  return `${l.seconds.toFixed(1)}s · speech ${l.speechDb} dBFS · noise ${l.noiseDb} · SNR ${l.snrDb} dB · peak ${l.peakDb} · ${l.voicedFrames} voiced frames${l.clippedPct ? ` · ${l.clippedPct}% clipped` : ""}`;
}

export class SttService {
  constructor(private readonly settings: () => VoiceSettings) {}

  async transcribe(audio: Buffer, options: TranscribeOptions = {}): Promise<TranscriptionResult> {
    const s = this.settings();
    const configured = s.language.trim().toLowerCase();
    const language = options.language ?? (configured && configured !== "auto" ? configured : undefined);
    const wav = await toWav16k(audio);
    const seconds = wav16kSeconds(wav);
    if (seconds < MIN_SPEECH_SECONDS) {
      return { text: "", durationMs: Math.round(seconds * 1000) };
    }
    if (seconds > MAX_SPEECH_SECONDS) {
      throw new Error(`Audio is ${Math.round(seconds)}s long; the limit is ${MAX_SPEECH_SECONDS}s per message.`);
    }
    const levels = measureLevels(wav);
    log.info(`Voice STT input: ${describeLevels(levels)}`);
    if (levels.voicedFrames < MIN_VOICED_FRAMES) {
      log.info(`Voice STT: no voice in ${seconds.toFixed(1)}s — not sent to an engine`);
      return { text: "", durationMs: Math.round(seconds * 1000), levels };
    }
    const prompt = options.prompt ?? DEFAULT_PROMPTS[(language ?? "es").slice(0, 2)];

    const errors: string[] = [];
    for (const engine of sttChain(s.sttEngine)) {
      if (!isCloudSttConfigured(engine)) {
        errors.push(`${engine}: not connected`);
        continue;
      }
      const started = Date.now();
      try {
        const text = engine === "whispercpp"
          ? await this.whisperCpp(wav, language, prompt, s)
          : await this.cloud(engine, wav, language, prompt);
        const cleaned = cleanTranscript(text, prompt);
        log.info(`Voice STT (${engine}): ${seconds.toFixed(1)}s audio → ${cleaned.length} chars in ${Date.now() - started}ms`);
        return { text: cleaned, language, engine, durationMs: Math.round(seconds * 1000), levels };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Voice STT: ${engine} failed (${msg})${s.sttEngine === "auto" ? " — trying the next engine" : ""}`);
        errors.push(`${engine}: ${msg}`);
      }
    }
    throw new Error(`No speech-to-text engine could transcribe this. ${errors.join(" · ")}`);
  }

  private async whisperCpp(wav: Buffer, language: string | undefined, prompt: string | undefined, s: VoiceSettings): Promise<string> {
    const model = await pickWhisperModel(s);
    const modelPath = await ensureWhisperModel(model);
    // Spawned from the models dir with relative paths, like Cinema does: on
    // Windows whisper-cli mangles non-ASCII absolute paths (C:\Users\José\…).
    const cwd = whisperModelsDir();
    mkdirSync(path.join(cwd, ".tmp"), { recursive: true });
    const dir = await mkdtemp(path.join(cwd, ".tmp", "voice-"));
    const wavPath = path.join(dir, "in.wav");
    try {
      await writeFile(wavPath, wav);
      const args = [
        "-m", path.relative(cwd, modelPath),
        "-f", path.relative(cwd, wavPath),
        "-nt", "-np",           // plain text on stdout, nothing else
        "-sns",                 // no "[Música]" tokens
        "-t", "4",
        "-l", language || "auto",
      ];
      if (prompt) args.push("--prompt", prompt);
      return await new Promise<string>((resolve, reject) => {
        const proc = spawn(mediaToolBin("whisper-cli"), args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        proc.stdout.on("data", (c: Buffer) => { out += c.toString(); });
        proc.stderr.on("data", (c: Buffer) => { err += c.toString(); });
        proc.on("error", (e) => reject(mediaToolError("whisper-cli", e)));
        proc.on("close", (code) => {
          recordObservedBackends(err);
          if (code === 0) resolve(out.replace(/\s+/g, " ").trim());
          else reject(new Error(`whisper-cli exited ${code}: ${err.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`));
        });
      });
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  }

  private async cloud(engine: "groq" | "openai", wav: Buffer, language: string | undefined, prompt: string | undefined): Promise<string> {
    const cfg = getProviderConfig(engine);
    const url = engine === "groq"
      ? (process.env.GROQ_API_URL ?? "https://api.groq.com/openai/v1/audio/transcriptions")
      : "https://api.openai.com/v1/audio/transcriptions";
    const model = engine === "groq" ? (process.env.GROQ_WHISPER_MODEL ?? "whisper-large-v3-turbo") : "whisper-1";
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    fd.append("model", model);
    fd.append("response_format", "json");
    if (language) fd.append("language", language);
    if (prompt) fd.append("prompt", prompt);
    const r = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      body: fd,
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`${engine} ${r.status}: ${t.slice(0, 200)}`);
    }
    const json = await r.json() as { text?: string };
    return (json.text ?? "").trim();
  }
}

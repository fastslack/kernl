/**
 * Text-to-speech.
 *
 * Piper is the default voice: local, free, real time on a CPU, and the only
 * offline engine with a rioplatense voice (es_AR-daniela-high). OpenAI and
 * ElevenLabs stay as the paid alternatives. `auto` walks piper → openai →
 * elevenlabs and keeps going past a failure, same as the STT side.
 *
 * Every engine's output is re-encoded to the requested format (ogg/opus by
 * default) so callers never care which one spoke.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { log } from "../core/logger.js";
import { getProviderConfig } from "../core/llm/credentials.js";
import { mediaToolBin, mediaToolError } from "../core/media-tools.js";
import { encodeWav, toWav16k } from "./audio.js";
import { DEFAULT_PIPER_VOICES, ensurePiperBinary, ensurePiperVoice, isPiperVoiceId } from "./downloads.js";
import type { SynthesisResult, SynthesizeOptions, TtsEngine, VoiceSettings } from "./types.js";

/** One reply, not an audiobook. Longer text is cut at a sentence boundary. */
export const MAX_SPEECH_CHARS = 4000;

const AUTO_ORDER: TtsEngine[] = ["piper", "openai", "elevenlabs"];

const OPENAI_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];

export function ttsChain(setting: VoiceSettings["ttsEngine"]): TtsEngine[] {
  return setting === "auto" ? AUTO_ORDER : [setting];
}

export function isTtsEngineConfigured(engine: TtsEngine, s: VoiceSettings): boolean {
  if (engine === "openai") return getProviderConfig("openai").apiKey !== "";
  if (engine === "elevenlabs") return s.elevenLabsApiKey.trim() !== "";
  return true;
}

/**
 * The voice id for `engine`. The setting is one string shared by all engines,
 * so a Piper id left in it while the chain falls through to OpenAI must not
 * be sent to OpenAI — each engine only takes ids it recognises.
 */
export function resolveVoice(engine: TtsEngine, s: VoiceSettings, override?: string): string {
  const wanted = (override ?? s.ttsVoice).trim();
  const configured = s.language.trim().toLowerCase();
  const lang = configured && configured !== "auto" ? configured.slice(0, 2) : "es";
  if (engine === "piper") {
    if (wanted && isPiperVoiceId(wanted)) return wanted;
    return DEFAULT_PIPER_VOICES[lang] ?? DEFAULT_PIPER_VOICES.en;
  }
  if (engine === "openai") return OPENAI_VOICES.includes(wanted) ? wanted : "nova";
  // ElevenLabs ids are opaque 20-char strings; anything else gets "Rachel".
  return /^[A-Za-z0-9]{20}$/.test(wanted) ? wanted : "21m00Tcm4TlvDq8ikWAM";
}

/** Trim to the limit at the last sentence end before it. */
export function clampForSpeech(text: string, max = MAX_SPEECH_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > max / 2 ? cut.slice(0, end + 1) : cut;
}

/** Piper resolves to a usable binary: PIPER_BIN, bundled, PATH — or a download. */
async function piperBin(): Promise<string> {
  const bin = mediaToolBin("piper");
  // A path (env override, bundle, earlier download) is used as given. Never
  // existsSync() the bare name: that resolves against the cwd, where a
  // directory called "piper" — the unpacked release itself — says yes.
  if (path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) return bin;
  // Bare name: either it is on PATH or it is nowhere. Try it, then download.
  const onPath = await new Promise<boolean>((resolve) => {
    const p = spawn(bin, ["--version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
  return onPath ? bin : ensurePiperBinary();
}

export class TtsService {
  constructor(private readonly settings: () => VoiceSettings) {}

  async synthesize(rawText: string, options: SynthesizeOptions = {}): Promise<SynthesisResult> {
    const s = this.settings();
    const text = clampForSpeech(rawText.trim());
    if (!text) throw new Error("Nothing to say");
    const format = options.format ?? "ogg";
    const speed = options.speed ?? s.ttsSpeed ?? 1;

    const errors: string[] = [];
    for (const engine of ttsChain(s.ttsEngine)) {
      if (!isTtsEngineConfigured(engine, s)) {
        errors.push(`${engine}: not connected`);
        continue;
      }
      const voice = resolveVoice(engine, s, options.voice?.voiceId);
      const started = Date.now();
      try {
        const audio = engine === "piper"
          ? await encodeWav(await this.piper(text, voice, speed), format)
          : engine === "openai"
            ? await this.openai(text, voice, speed, format)
            : await this.elevenlabs(text, voice, s, format);
        log.info(`Voice TTS (${engine}/${voice}): ${text.length} chars → ${audio.length} bytes in ${Date.now() - started}ms`);
        return { audio, format, engine };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Voice TTS: ${engine} failed (${msg})${s.ttsEngine === "auto" ? " — trying the next engine" : ""}`);
        errors.push(`${engine}: ${msg}`);
      }
    }
    throw new Error(`No text-to-speech engine could speak this. ${errors.join(" · ")}`);
  }

  /** Piper → WAV bytes. */
  private async piper(text: string, voice: string, speed: number): Promise<Buffer> {
    const [bin, model] = await Promise.all([piperBin(), ensurePiperVoice(voice)]);
    const dir = await mkdtemp(path.join(tmpdir(), "kernl-tts-"));
    const out = path.join(dir, "out.wav");
    try {
      await new Promise<void>((resolve, reject) => {
        const args = [
          "-m", model,
          "-f", out,
          // Piper's knob is duration, the inverse of speed.
          "--length_scale", String(1 / Math.min(2, Math.max(0.5, speed || 1))),
          "--sentence_silence", "0.15",
          "-q",
        ];
        const proc = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
        let err = "";
        const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
        proc.stderr.on("data", (c: Buffer) => { err += c.toString(); });
        proc.on("error", (e) => { clearTimeout(timer); reject(mediaToolError("piper", e)); });
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`piper exited ${code}: ${err.trim().slice(-300)}`));
        });
        proc.stdin.on("error", () => {});
        // One line per sentence keeps Piper's own pauses between them.
        proc.stdin.end(text.replace(/([.!?])\s+/g, "$1\n") + "\n");
      });
      return await readFile(out);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async openai(text: string, voice: string, speed: number, format: "ogg" | "mp3" | "wav"): Promise<Buffer> {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        authorization: `Bearer ${getProviderConfig("openai").apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input: text,
        speed,
        // OpenAI's "opus" is ogg-wrapped opus — exactly what we deliver.
        response_format: format === "ogg" ? "opus" : format,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return Buffer.from(await r.arrayBuffer());
  }

  private async elevenlabs(text: string, voice: string, s: VoiceSettings, format: "ogg" | "mp3" | "wav"): Promise<Buffer> {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: {
        "xi-api-key": s.elevenLabsApiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const mp3 = Buffer.from(await r.arrayBuffer());
    if (format === "mp3") return mp3;
    // The one engine that cannot produce ogg itself: decode, then re-encode.
    return encodeWav(await toWav16k(mp3), format);
  }
}

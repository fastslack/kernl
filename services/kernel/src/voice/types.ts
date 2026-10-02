/**
 * Voice Types
 * Common interfaces for speech-to-text and text-to-speech
 */

/** STT engines, in the order `auto` tries them. */
export type SttEngine = "whispercpp" | "groq" | "openai";

/** TTS engines, in the order `auto` tries them. */
export type TtsEngine = "piper" | "openai" | "elevenlabs";

/** What the settings hold: one engine, or `auto` for the fallback chain. */
export type SttEngineSetting = SttEngine | "auto";
export type TtsEngineSetting = TtsEngine | "auto";

/** Audio format for input/output */
export type AudioFormat = "mp3" | "wav" | "ogg" | "webm" | "m4a" | "flac";

/** STT result */
export interface TranscriptionResult {
  text: string;
  confidence?: number;
  language?: string;
  durationMs?: number;
  /** Engine that produced it — the auto chain may have fallen through. */
  engine?: SttEngine;
  /** How the input sounded — for the mic check and the log. */
  levels?: import("./audio.js").AudioLevels;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    confidence?: number;
  }>;
}

/** TTS result */
export interface SynthesisResult {
  audio: Buffer;
  format: AudioFormat;
  durationMs?: number;
  /** Engine that produced it — the auto chain may have fallen through. */
  engine?: TtsEngine;
}

/** Voice/speaker configuration */
export interface VoiceConfig {
  voiceId: string;
  name?: string;
  language?: string;
  style?: string;
  pitch?: number;
  speed?: number;
}

/** STT options */
export interface TranscribeOptions {
  language?: string;
  prompt?: string;
  temperature?: number;
  timestamps?: boolean;
  /** Container of the input, when the caller knows it (webm from a browser,
   *  ogg from Telegram). ffmpeg sniffs it anyway; cloud engines need a name. */
  mimeType?: string;
}

/** TTS options */
export interface SynthesizeOptions {
  voice?: VoiceConfig;
  /** `ogg` (opus) is the default: Telegram requires it for voice notes and
   *  every browser plays it at a fraction of WAV's size. */
  format?: "ogg" | "mp3" | "wav";
  speed?: number;
}

/** The live settings the service reads on every call (KernelConfig.voice). */
export interface VoiceSettings {
  enabled: boolean;
  sttEngine: SttEngineSetting;
  /** ggml model name; empty = pick from the compute backend. */
  whisperModel: string;
  /** ISO-639-1, or "auto" to detect per utterance. */
  language: string;
  ttsEngine: TtsEngineSetting;
  /** Engine-specific voice id; empty = the engine's default for `language`. */
  ttsVoice: string;
  ttsSpeed: number;
  elevenLabsApiKey: string;
}

/** One engine's readiness, as /api/voice/status reports it. */
export interface EngineStatus {
  engine: SttEngine | TtsEngine;
  /** Usable right now without a download. */
  ready: boolean;
  /** Usable after a one-time download (model or binary). */
  downloadable?: boolean;
  /** Why it is not ready, in one sentence. */
  reason?: string;
}

export interface VoiceStatus {
  enabled: boolean;
  stt: { setting: SttEngineSetting; active: SttEngine | null; engines: EngineStatus[]; model: string };
  tts: { setting: TtsEngineSetting; active: TtsEngine | null; engines: EngineStatus[]; voice: string };
  language: string;
}

/** Voice service interface */
export interface IVoiceService {
  /** Transcribe audio to text */
  transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult>;

  /** Synthesize text to audio */
  synthesize(text: string, options?: SynthesizeOptions): Promise<SynthesisResult>;
}

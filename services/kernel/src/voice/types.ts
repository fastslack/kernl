/**
 * Voice Types
 * Common interfaces for speech-to-text and text-to-speech
 */

/** Supported STT providers */
export type SttProvider = "openai" | "local-whisper" | "google" | "azure";

/** Supported TTS providers */
export type TtsProvider = "elevenlabs" | "openai" | "google" | "azure" | "system";

/** Audio format for input/output */
export type AudioFormat = "mp3" | "wav" | "ogg" | "webm" | "m4a" | "flac";

/** STT result */
export interface TranscriptionResult {
  text: string;
  confidence?: number;
  language?: string;
  durationMs?: number;
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
}

/** TTS options */
export interface SynthesizeOptions {
  voice?: VoiceConfig;
  format?: AudioFormat;
  speed?: number;
  pitch?: number;
  /** Add SSML tags for emphasis, pauses, etc. */
  ssml?: boolean;
}

/** Voice service configuration */
export interface VoiceServiceConfig {
  stt: {
    provider: SttProvider;
    openaiApiKey?: string;
    googleApiKey?: string;
    azureApiKey?: string;
    azureRegion?: string;
    localWhisperPath?: string;
  };
  tts: {
    provider: TtsProvider;
    elevenLabsApiKey?: string;
    openaiApiKey?: string;
    googleApiKey?: string;
    azureApiKey?: string;
    azureRegion?: string;
    defaultVoice?: VoiceConfig;
  };
}

/** Voice activity detection result */
export interface VadResult {
  hasVoice: boolean;
  segments?: Array<{
    start: number;
    end: number;
    confidence: number;
  }>;
}

/** Wake word detection result */
export interface WakeWordResult {
  detected: boolean;
  keyword?: string;
  confidence?: number;
  timestamp?: number;
}

/** Voice service interface */
export interface IVoiceService {
  /** Transcribe audio to text */
  transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult>;
  
  /** Synthesize text to audio */
  synthesize(text: string, options?: SynthesizeOptions): Promise<SynthesisResult>;
  
  /** Get available voices for TTS */
  getVoices(): Promise<VoiceConfig[]>;
  
  /** Check if voice activity is present in audio */
  detectVoiceActivity?(audio: Buffer): Promise<VadResult>;
  
  /** Check if a wake word was spoken */
  detectWakeWord?(audio: Buffer): Promise<WakeWordResult>;
}

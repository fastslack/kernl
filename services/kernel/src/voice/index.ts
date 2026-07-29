/**
 * Voice Module
 * Speech-to-text and text-to-speech capabilities
 */

// Types
export type {
  SttProvider,
  TtsProvider,
  AudioFormat,
  TranscriptionResult,
  SynthesisResult,
  VoiceConfig,
  TranscribeOptions,
  SynthesizeOptions,
  VoiceServiceConfig,
  VadResult,
  WakeWordResult,
  IVoiceService,
} from "./types.js";

// Services
export { SttService } from "./stt.js";
export { TtsService } from "./tts.js";
export { VoiceService, createVoiceServiceFromEnv } from "./service.js";

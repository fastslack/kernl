/**
 * Voice Module
 * Speech-to-text and text-to-speech capabilities
 */

// Types
export type {
  SttEngine,
  TtsEngine,
  SttEngineSetting,
  TtsEngineSetting,
  AudioFormat,
  TranscriptionResult,
  SynthesisResult,
  VoiceConfig,
  TranscribeOptions,
  SynthesizeOptions,
  VoiceSettings,
  VoiceStatus,
  EngineStatus,
  IVoiceService,
} from "./types.js";

// Services
export { SttService } from "./stt.js";
export { TtsService } from "./tts.js";
export { VoiceService } from "./service.js";
export { registerVoiceRoutes } from "./routes.js";
export { toSpeakable, cleanTranscript } from "./text.js";

/**
 * Voice settings from the environment — the seed for `config.voice` before
 * the stored settings (Settings → AI → Voice) are applied over it.
 *
 * Kept free of imports beyond types: config.ts loads this, and the engines
 * pull in config-dependent modules that would make that a cycle.
 *
 * The variables from the first voice module still mean what they meant:
 * VOICE_STT_PROVIDER=local-whisper is whisper.cpp, VOICE_TTS_PROVIDER=system
 * (a `say`/espeak path that no longer exists) becomes `auto`, and
 * VOICE_DEFAULT_ID seeds the voice.
 */

import type { SttEngineSetting, TtsEngineSetting, VoiceSettings } from "./types.js";

const STT: SttEngineSetting[] = ["auto", "whispercpp", "groq", "openai"];
const TTS: TtsEngineSetting[] = ["auto", "piper", "openai", "elevenlabs"];

export function parseSttEngine(raw: string | undefined): SttEngineSetting {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "local-whisper" || v === "whisper" || v === "whisper.cpp") return "whispercpp";
  return (STT as string[]).includes(v) ? (v as SttEngineSetting) : "auto";
}

export function parseTtsEngine(raw: string | undefined): TtsEngineSetting {
  const v = (raw ?? "").trim().toLowerCase();
  return (TTS as string[]).includes(v) ? (v as TtsEngineSetting) : "auto";
}

export function parseSpeed(raw: string | undefined): number {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) && n >= 0.5 && n <= 2 ? n : 1;
}

export function voiceSettingsFromEnv(env: NodeJS.ProcessEnv): VoiceSettings {
  return {
    // On unless turned off: every engine in `auto` is local and free.
    enabled: env.VOICE_ENABLED !== "false",
    sttEngine: parseSttEngine(env.VOICE_STT_ENGINE ?? env.VOICE_STT_PROVIDER),
    whisperModel: env.VOICE_WHISPER_MODEL ?? "",
    language: env.VOICE_LANGUAGE ?? "es",
    ttsEngine: parseTtsEngine(env.VOICE_TTS_ENGINE ?? env.VOICE_TTS_PROVIDER),
    // "alloy" was the old default for an OpenAI-only module; as a seed it would
    // pin every engine to a voice only one of them has.
    ttsVoice: env.VOICE_TTS_VOICE ?? (env.VOICE_DEFAULT_ID && env.VOICE_DEFAULT_ID !== "alloy" ? env.VOICE_DEFAULT_ID : ""),
    ttsSpeed: parseSpeed(env.VOICE_TTS_SPEED),
    elevenLabsApiKey: env.ELEVENLABS_API_KEY ?? "",
  };
}

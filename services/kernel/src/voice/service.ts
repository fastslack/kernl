/**
 * Voice Service
 *
 * One door onto speech for every channel: the dashboard's mic button, Telegram
 * voice notes, anything later. It reads `config.voice` on every call rather
 * than at construction, so a change saved in Settings applies to the next
 * utterance without a restart.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { KernelConfig } from "../core/config.js";
import { mediaToolBin, probeMediaTool } from "../core/media-tools.js";
import { SttService, isCloudSttConfigured, pickWhisperModel, sttChain } from "./stt.js";
import { TtsService, isTtsEngineConfigured, resolveVoice, ttsChain } from "./tts.js";
import {
  adoptDownloadedPiper,
  downloadedPiperBin,
  piperArchiveName,
  piperVoicePath,
  whisperModelPath,
  VOICE_CATALOG,
  type VoiceOption,
} from "./downloads.js";
import type {
  EngineStatus,
  IVoiceService,
  SttEngine,
  SynthesisResult,
  SynthesizeOptions,
  TranscribeOptions,
  TranscriptionResult,
  TtsEngine,
  VoiceSettings,
  VoiceStatus,
} from "./types.js";

export class VoiceService implements IVoiceService {
  private readonly stt: SttService;
  private readonly tts: TtsService;

  constructor(private readonly config: Pick<KernelConfig, "voice">) {
    const settings = () => this.config.voice;
    this.stt = new SttService(settings);
    this.tts = new TtsService(settings);
    adoptDownloadedPiper();
  }

  get enabled(): boolean {
    return this.config.voice.enabled;
  }

  transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
    return this.stt.transcribe(audio, options);
  }

  synthesize(text: string, options?: SynthesizeOptions): Promise<SynthesisResult> {
    return this.tts.synthesize(text, options);
  }

  /** The voices Settings offers, with whether each Piper one is already on disk. */
  suggestedVoices(): Array<VoiceOption & { downloaded: boolean }> {
    return VOICE_CATALOG.map((v) => ({
      ...v,
      downloaded: v.engine === "piper" ? existsSync(piperVoicePath(v.id)) : true,
    }));
  }

  /** What would run right now, and what each engine still needs. Never throws. */
  async status(): Promise<VoiceStatus> {
    const s: VoiceSettings = this.config.voice;
    const model = await pickWhisperModel(s).catch(() => s.whisperModel || "small");

    const sttEngines: EngineStatus[] = await Promise.all(
      (["whispercpp", "groq", "openai"] as SttEngine[]).map(async (engine) => {
        if (engine !== "whispercpp") {
          const ok = isCloudSttConfigured(engine);
          return { engine, ready: ok, reason: ok ? undefined : `Connect ${engine === "groq" ? "Groq" : "OpenAI"} in Settings → AI` };
        }
        const bin = await probeMediaTool("whisper-cli");
        if (!bin.available) return { engine, ready: false, reason: bin.reason ?? "whisper-cli not found" };
        const have = existsSync(whisperModelPath(model));
        return { engine, ready: have, downloadable: !have, reason: have ? undefined : `Model ggml-${model}.bin downloads on first use` };
      }),
    );

    const voice = resolveVoice("piper", s);
    const ttsEngines: EngineStatus[] = await Promise.all(
      (["piper", "openai", "elevenlabs"] as TtsEngine[]).map(async (engine) => {
        if (engine !== "piper") {
          const ok = isTtsEngineConfigured(engine, s);
          return { engine, ready: ok, reason: ok ? undefined : engine === "openai" ? "Connect OpenAI in Settings → AI" : "Add an ElevenLabs API key" };
        }
        const binReady = await piperRuns();
        const voiceReady = existsSync(piperVoicePath(voice));
        const canDownload = binReady || piperArchiveName() !== null;
        if (binReady && voiceReady) return { engine, ready: true };
        return {
          engine,
          ready: false,
          downloadable: canDownload,
          reason: canDownload
            ? `${binReady ? "" : "Piper and "}voice ${voice} download on first use`
            : `No Piper build for ${process.platform}/${process.arch}`,
        };
      }),
    );

    const firstUsable = <T extends { engine: string; ready: boolean; downloadable?: boolean }>(chain: string[], list: T[]) =>
      chain.map((e) => list.find((x) => x.engine === e)).find((x) => x && (x.ready || x.downloadable))?.engine ?? null;

    return {
      enabled: s.enabled,
      language: s.language,
      stt: { setting: s.sttEngine, active: firstUsable(sttChain(s.sttEngine), sttEngines) as SttEngine | null, engines: sttEngines, model },
      tts: { setting: s.ttsEngine, active: firstUsable(ttsChain(s.ttsEngine), ttsEngines) as TtsEngine | null, engines: ttsEngines, voice: s.ttsEngine === "auto" || s.ttsEngine === "piper" ? voice : resolveVoice(s.ttsEngine, s) },
    };
  }
}

/** Piper is runnable as resolved now (env/bundle/PATH/earlier download). */
async function piperRuns(): Promise<boolean> {
  if (existsSync(downloadedPiperBin())) return true;
  const status = await probeMediaTool("piper");
  if (status.available) return true;
  // probeMediaTool caches for a minute; a fresh PATH lookup is cheap enough.
  return new Promise((resolve) => {
    const p = spawn(mediaToolBin("piper"), ["--version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

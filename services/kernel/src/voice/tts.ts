/**
 * Text-to-Speech (TTS) Module
 * Supports ElevenLabs, OpenAI, and system TTS
 */

import OpenAI from "openai";
import { log } from "../core/logger.js";
import type {
  TtsProvider,
  SynthesisResult,
  SynthesizeOptions,
  VoiceConfig,
  VoiceServiceConfig,
  AudioFormat,
} from "./types.js";

/** ElevenLabs voice settings */
interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
  style?: number;
  use_speaker_boost?: boolean;
}

/**
 * Text-to-Speech synthesis service
 */
export class TtsService {
  private openai: OpenAI | null = null;
  private provider: TtsProvider;
  private defaultVoice: VoiceConfig;

  constructor(private config: VoiceServiceConfig["tts"]) {
    this.provider = config.provider;
    this.defaultVoice = config.defaultVoice ?? {
      voiceId: "alloy", // OpenAI default
      name: "Alloy",
    };

    if ((this.provider === "openai" || this.provider === "elevenlabs") && config.openaiApiKey) {
      this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    }
  }

  /**
   * Synthesize text to audio
   */
  async synthesize(
    text: string,
    options?: SynthesizeOptions
  ): Promise<SynthesisResult> {
    switch (this.provider) {
      case "elevenlabs":
        return this.synthesizeWithElevenLabs(text, options);
      case "openai":
        return this.synthesizeWithOpenAI(text, options);
      case "system":
        return this.synthesizeWithSystem(text, options);
      default:
        throw new Error(`TTS provider ${this.provider} not supported`);
    }
  }

  /**
   * Synthesize using ElevenLabs API
   */
  private async synthesizeWithElevenLabs(
    text: string,
    options?: SynthesizeOptions
  ): Promise<SynthesisResult> {
    const apiKey = this.config.elevenLabsApiKey;
    if (!apiKey) {
      throw new Error("ElevenLabs API key not configured");
    }

    const voice = options?.voice ?? this.defaultVoice;
    const voiceId = voice.voiceId || "21m00Tcm4TlvDq8ikWAM"; // Rachel default

    log.debug(`TTS: synthesizing with ElevenLabs voice ${voiceId}...`);

    try {
      const voiceSettings: ElevenLabsVoiceSettings = {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.5,
        use_speaker_boost: true,
      };

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_multilingual_v2",
            voice_settings: voiceSettings,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ElevenLabs API error: ${response.status} - ${error}`);
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());

      log.info(`TTS: ElevenLabs synthesis complete - ${audioBuffer.length} bytes`);
      return {
        audio: audioBuffer,
        format: "mp3",
      };
    } catch (err) {
      log.error("TTS: ElevenLabs synthesis failed", err);
      throw err;
    }
  }

  /**
   * Synthesize using OpenAI TTS API
   */
  private async synthesizeWithOpenAI(
    text: string,
    options?: SynthesizeOptions
  ): Promise<SynthesisResult> {
    if (!this.openai) {
      throw new Error("OpenAI client not configured");
    }

    const voice = options?.voice ?? this.defaultVoice;
    const voiceId = voice.voiceId as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

    log.debug(`TTS: synthesizing with OpenAI voice ${voiceId}...`);

    try {
      const response = await this.openai.audio.speech.create({
        model: "tts-1",
        voice: voiceId || "alloy",
        input: text,
        speed: options?.speed ?? 1.0,
        response_format: this.mapFormat(options?.format),
      });

      const audioBuffer = Buffer.from(await response.arrayBuffer());

      log.info(`TTS: OpenAI synthesis complete - ${audioBuffer.length} bytes`);
      return {
        audio: audioBuffer,
        format: options?.format ?? "mp3",
      };
    } catch (err) {
      log.error("TTS: OpenAI synthesis failed", err);
      throw err;
    }
  }

  /**
   * Synthesize using system TTS (macOS `say`, espeak on Linux)
   */
  private async synthesizeWithSystem(
    text: string,
    options?: SynthesizeOptions
  ): Promise<SynthesisResult> {
    log.debug("TTS: synthesizing with system TTS...");

    const { spawn } = await import("child_process");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { randomUUID } = await import("crypto");
    const { readFileSync, unlinkSync } = await import("fs");

    const outputFile = join(tmpdir(), `tts-${randomUUID()}.aiff`);
    const platform = process.platform;

    try {
      if (platform === "darwin") {
        // macOS: use `say` command
        const voice = options?.voice?.name ?? "Samantha";
        const rate = options?.speed ? Math.round(options.speed * 200) : 200;

        await new Promise<void>((resolve, reject) => {
          const proc = spawn("say", [
            "-v", voice,
            "-r", rate.toString(),
            "-o", outputFile,
            text,
          ]);
          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`say exited with code ${code}`));
          });
          proc.on("error", reject);
        });

        const audio = readFileSync(outputFile);
        
        log.info(`TTS: system synthesis complete - ${audio.length} bytes`);
        return {
          audio,
          format: "wav", // aiff is similar to wav
        };
      } else if (platform === "linux") {
        // Linux: use espeak
        const mp3File = outputFile.replace(".aiff", ".wav");
        
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("espeak", [
            "-w", mp3File,
            text,
          ]);
          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`espeak exited with code ${code}`));
          });
          proc.on("error", reject);
        });

        const audio = readFileSync(mp3File);
        unlinkSync(mp3File);

        log.info(`TTS: system synthesis complete - ${audio.length} bytes`);
        return {
          audio,
          format: "wav",
        };
      } else {
        throw new Error(`System TTS not supported on ${platform}`);
      }
    } finally {
      try {
        unlinkSync(outputFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Get available voices
   */
  async getVoices(): Promise<VoiceConfig[]> {
    switch (this.provider) {
      case "elevenlabs":
        return this.getElevenLabsVoices();
      case "openai":
        return this.getOpenAIVoices();
      case "system":
        return this.getSystemVoices();
      default:
        return [];
    }
  }

  private async getElevenLabsVoices(): Promise<VoiceConfig[]> {
    const apiKey = this.config.elevenLabsApiKey;
    if (!apiKey) return [];

    try {
      const response = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": apiKey },
      });

      if (!response.ok) return [];

      const data = await response.json() as { voices: Array<{ voice_id: string; name: string }> };
      return data.voices.map((v) => ({
        voiceId: v.voice_id,
        name: v.name,
      }));
    } catch {
      return [];
    }
  }

  private getOpenAIVoices(): Promise<VoiceConfig[]> {
    // OpenAI has fixed voices
    return Promise.resolve([
      { voiceId: "alloy", name: "Alloy" },
      { voiceId: "echo", name: "Echo" },
      { voiceId: "fable", name: "Fable" },
      { voiceId: "onyx", name: "Onyx" },
      { voiceId: "nova", name: "Nova" },
      { voiceId: "shimmer", name: "Shimmer" },
    ]);
  }

  private async getSystemVoices(): Promise<VoiceConfig[]> {
    const platform = process.platform;
    
    if (platform === "darwin") {
      // macOS: list voices with `say -v ?`
      const { execSync } = await import("child_process");
      try {
        const output = execSync("say -v ?", { encoding: "utf-8" });
        return output.split("\n").filter(Boolean).map((line) => {
          const match = line.match(/^(\S+)\s+(\w+)/);
          return {
            voiceId: match?.[1] ?? line,
            name: match?.[1] ?? line,
            language: match?.[2],
          };
        });
      } catch {
        return [];
      }
    }
    
    return [];
  }

  private mapFormat(format?: AudioFormat): "mp3" | "opus" | "aac" | "flac" {
    switch (format) {
      case "ogg":
      case "webm":
        return "opus";
      case "m4a":
        return "aac";
      case "flac":
        return "flac";
      default:
        return "mp3";
    }
  }

  /**
   * Get the current TTS provider
   */
  getProvider(): TtsProvider {
    return this.provider;
  }

  /**
   * Check if the service is configured and ready
   */
  isReady(): boolean {
    switch (this.provider) {
      case "elevenlabs":
        return !!this.config.elevenLabsApiKey;
      case "openai":
        return this.openai !== null;
      case "system":
        return true;
      default:
        return false;
    }
  }
}

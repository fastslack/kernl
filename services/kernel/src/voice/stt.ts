/**
 * Speech-to-Text (STT) Module
 * Supports OpenAI Whisper API and local Whisper
 */

import OpenAI from "openai";
import { log } from "../core/logger.js";
import type {
  SttProvider,
  TranscriptionResult,
  TranscribeOptions,
  VoiceServiceConfig,
} from "./types.js";

/**
 * Speech-to-Text transcription service
 */
export class SttService {
  private openai: OpenAI | null = null;
  private provider: SttProvider;

  constructor(private config: VoiceServiceConfig["stt"]) {
    this.provider = config.provider;
    
    if (this.provider === "openai" && config.openaiApiKey) {
      this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    }
  }

  /**
   * Transcribe audio buffer to text
   */
  async transcribe(
    audio: Buffer,
    options?: TranscribeOptions
  ): Promise<TranscriptionResult> {
    switch (this.provider) {
      case "openai":
        return this.transcribeWithOpenAI(audio, options);
      case "local-whisper":
        return this.transcribeWithLocalWhisper(audio, options);
      default:
        throw new Error(`STT provider ${this.provider} not supported`);
    }
  }

  /**
   * Transcribe using OpenAI Whisper API
   */
  private async transcribeWithOpenAI(
    audio: Buffer,
    options?: TranscribeOptions
  ): Promise<TranscriptionResult> {
    if (!this.openai) {
      throw new Error("OpenAI client not configured");
    }

    log.debug("STT: transcribing with OpenAI Whisper...");

    try {
      // Create a File object from the buffer
      // Node Buffers are ArrayBufferLike-backed, which BlobPart no longer accepts;
      // the copy hands File a plain ArrayBuffer-backed view.
      const file = new File([new Uint8Array(audio)], "audio.ogg", { type: "audio/ogg" });

      const response = await this.openai.audio.transcriptions.create({
        file,
        model: "whisper-1",
        language: options?.language,
        prompt: options?.prompt,
        temperature: options?.temperature ?? 0,
        response_format: options?.timestamps ? "verbose_json" : "json",
      });

      // Handle different response formats
      if (typeof response === "string") {
        return { text: response };
      }

      const responseAny = response as unknown as { 
        text: string; 
        language?: string; 
        duration?: number;
        words?: Array<{ word: string; start: number; end: number }>;
        segments?: Array<{ text: string; start: number; end: number }>;
      };
      
      const result: TranscriptionResult = {
        text: responseAny.text,
        language: responseAny.language,
        durationMs: responseAny.duration 
          ? Math.round(responseAny.duration * 1000) 
          : undefined,
      };

      // Extract word-level timestamps if available
      if (responseAny.words) {
        result.words = responseAny.words.map((w) => ({
          word: w.word,
          start: w.start,
          end: w.end,
        }));
      }

      log.info(`STT: transcribed ${result.text.length} chars`);
      return result;
    } catch (err) {
      log.error("STT: OpenAI transcription failed", err);
      throw err;
    }
  }

  /**
   * Transcribe using local Whisper (via whisper.cpp or similar)
   * This is a placeholder - actual implementation depends on local setup
   */
  private async transcribeWithLocalWhisper(
    audio: Buffer,
    options?: TranscribeOptions
  ): Promise<TranscriptionResult> {
    const whisperPath = this.config.localWhisperPath;
    
    if (!whisperPath) {
      throw new Error("Local Whisper path not configured");
    }

    log.debug("STT: transcribing with local Whisper...");

    // For local whisper, we need to:
    // 1. Write audio to temp file
    // 2. Run whisper.cpp or whisper CLI
    // 3. Parse output
    // This requires whisper.cpp to be installed locally

    const { spawn } = await import("child_process");
    const { writeFileSync, unlinkSync, readFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { randomUUID } = await import("crypto");

    const tempInput = join(tmpdir(), `whisper-${randomUUID()}.wav`);
    const tempOutput = join(tmpdir(), `whisper-${randomUUID()}.txt`);

    try {
      // Write audio to temp file
      writeFileSync(tempInput, audio);

      // Run whisper
      const args = [
        "-m", join(whisperPath, "models/ggml-base.en.bin"),
        "-f", tempInput,
        "-otxt",
        "-of", tempOutput.replace(".txt", ""),
      ];

      if (options?.language) {
        args.push("-l", options.language);
      }

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(join(whisperPath, "main"), args);
        proc.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Whisper exited with code ${code}`));
        });
        proc.on("error", reject);
      });

      // Read output
      const text = readFileSync(tempOutput, "utf-8").trim();

      log.info(`STT: local transcription complete - ${text.length} chars`);
      return { text };
    } finally {
      // Cleanup
      try {
        unlinkSync(tempInput);
        unlinkSync(tempOutput);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Get the current STT provider
   */
  getProvider(): SttProvider {
    return this.provider;
  }

  /**
   * Check if the service is configured and ready
   */
  isReady(): boolean {
    switch (this.provider) {
      case "openai":
        return this.openai !== null;
      case "local-whisper":
        return !!this.config.localWhisperPath;
      default:
        return false;
    }
  }
}

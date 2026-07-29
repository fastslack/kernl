/**
 * Voice Service
 * Unified interface for speech-to-text and text-to-speech
 */

import { log } from "../core/logger.js";
import { SttService } from "./stt.js";
import { TtsService } from "./tts.js";
import type {
  IVoiceService,
  VoiceServiceConfig,
  TranscriptionResult,
  SynthesisResult,
  TranscribeOptions,
  SynthesizeOptions,
  VoiceConfig,
} from "./types.js";

/**
 * Main Voice Service
 * Combines STT and TTS capabilities
 */
export class VoiceService implements IVoiceService {
  private stt: SttService;
  private tts: TtsService;

  constructor(config: VoiceServiceConfig) {
    this.stt = new SttService(config.stt);
    this.tts = new TtsService(config.tts);
    
    log.info(`VoiceService: initialized with STT=${config.stt.provider}, TTS=${config.tts.provider}`);
  }

  /**
   * Transcribe audio to text
   */
  async transcribe(
    audio: Buffer,
    options?: TranscribeOptions
  ): Promise<TranscriptionResult> {
    return this.stt.transcribe(audio, options);
  }

  /**
   * Synthesize text to audio
   */
  async synthesize(
    text: string,
    options?: SynthesizeOptions
  ): Promise<SynthesisResult> {
    return this.tts.synthesize(text, options);
  }

  /**
   * Get available TTS voices
   */
  async getVoices(): Promise<VoiceConfig[]> {
    return this.tts.getVoices();
  }

  /**
   * Check if STT is ready
   */
  isSttReady(): boolean {
    return this.stt.isReady();
  }

  /**
   * Check if TTS is ready
   */
  isTtsReady(): boolean {
    return this.tts.isReady();
  }

  /**
   * Get STT provider name
   */
  getSttProvider(): string {
    return this.stt.getProvider();
  }

  /**
   * Get TTS provider name
   */
  getTtsProvider(): string {
    return this.tts.getProvider();
  }

  /**
   * Process a voice message from a channel
   * Transcribes the audio and optionally responds with voice
   */
  async processVoiceMessage(
    audio: Buffer,
    respondWithVoice: boolean = false,
    messageHandler?: (text: string) => Promise<string>
  ): Promise<{
    transcription: TranscriptionResult;
    response?: string;
    responseAudio?: SynthesisResult;
  }> {
    // Transcribe the incoming audio
    const transcription = await this.transcribe(audio);

    const result: {
      transcription: TranscriptionResult;
      response?: string;
      responseAudio?: SynthesisResult;
    } = { transcription };

    // If there's a message handler, process the transcribed text
    if (messageHandler && transcription.text) {
      result.response = await messageHandler(transcription.text);

      // If voice response is requested, synthesize it
      if (respondWithVoice && result.response) {
        result.responseAudio = await this.synthesize(result.response);
      }
    }

    return result;
  }

  /**
   * Create a voice-enabled chat flow
   * Useful for voice-based interactions
   */
  createVoiceChatHandler(
    chatHandler: (text: string) => Promise<string>,
    options?: {
      respondWithVoice?: boolean;
      transcribeOptions?: TranscribeOptions;
      synthesizeOptions?: SynthesizeOptions;
    }
  ): (audio: Buffer) => Promise<{
    inputText: string;
    outputText: string;
    outputAudio?: Buffer;
  }> {
    return async (audio: Buffer) => {
      // Transcribe input
      const transcription = await this.transcribe(audio, options?.transcribeOptions);
      
      // Get response from chat handler
      const outputText = await chatHandler(transcription.text);

      const result: {
        inputText: string;
        outputText: string;
        outputAudio?: Buffer;
      } = {
        inputText: transcription.text,
        outputText,
      };

      // Synthesize response if requested
      if (options?.respondWithVoice !== false) {
        const synthesis = await this.synthesize(outputText, options?.synthesizeOptions);
        result.outputAudio = synthesis.audio;
      }

      return result;
    };
  }
}

/**
 * Create a VoiceService from environment variables
 */
export function createVoiceServiceFromEnv(): VoiceService | null {
  const openaiKey = process.env.OPENAI_API_KEY;
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;

  // Determine STT provider
  let sttProvider: VoiceServiceConfig["stt"]["provider"] = "openai";
  if (process.env.LOCAL_WHISPER_PATH) {
    sttProvider = "local-whisper";
  }

  // Determine TTS provider
  let ttsProvider: VoiceServiceConfig["tts"]["provider"] = "system";
  if (elevenLabsKey) {
    ttsProvider = "elevenlabs";
  } else if (openaiKey) {
    ttsProvider = "openai";
  }

  // Check if we have minimum config
  if (!openaiKey && !process.env.LOCAL_WHISPER_PATH) {
    log.warn("VoiceService: no STT provider configured (set OPENAI_API_KEY or LOCAL_WHISPER_PATH)");
    return null;
  }

  const config: VoiceServiceConfig = {
    stt: {
      provider: sttProvider,
      openaiApiKey: openaiKey,
      localWhisperPath: process.env.LOCAL_WHISPER_PATH,
    },
    tts: {
      provider: ttsProvider,
      elevenLabsApiKey: elevenLabsKey,
      openaiApiKey: openaiKey,
      defaultVoice: {
        voiceId: process.env.TTS_DEFAULT_VOICE || "alloy",
        name: process.env.TTS_DEFAULT_VOICE_NAME || "Alloy",
      },
    },
  };

  return new VoiceService(config);
}

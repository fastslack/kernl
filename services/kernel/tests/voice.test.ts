/**
 * Voice: the text that goes in and out, the settings, the engine chains, the
 * HTTP routes and the Telegram wiring. The engines themselves shell out to
 * whisper-cli / piper / ffmpeg and are exercised against the real binaries in
 * the container, not here.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { toSpeakable, cleanTranscript } from "../src/voice/text.js";
import { voiceSettingsFromEnv, parseSttEngine, parseTtsEngine, parseSpeed } from "../src/voice/settings.js";
import { sttChain, SttService } from "../src/voice/stt.js";
import { voicedFrames, measureLevels } from "../src/voice/audio.js";
import { ttsChain, resolveVoice, clampForSpeech } from "../src/voice/tts.js";
import { piperVoiceUrl, isPiperVoiceId, piperArchiveName, VOICE_CATALOG } from "../src/voice/downloads.js";
import { registerVoiceRoutes } from "../src/voice/routes.js";
import type { VoiceService } from "../src/voice/service.js";
import type { VoiceSettings } from "../src/voice/types.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { wireMessageRouting } from "../src/core/message-routing.js";

const settings = (over: Partial<VoiceSettings> = {}): VoiceSettings => ({
  ...voiceSettingsFromEnv({}),
  ...over,
});

describe("toSpeakable", () => {
  it("keeps the words and drops the markdown", () => {
    const md = "## Resumen\n\n**Tres** tareas para hoy:\n- Llamar a [Ana](https://x.com/ana)\n- Revisar `kernel.db`\n\n```ts\nconst x = 1;\n```\nListo.";
    expect(toSpeakable(md)).toBe("Resumen. Tres tareas para hoy: Llamar a Ana. Revisar kernel.db. Listo.");
  });

  it("does not read URLs, emails or emoji", () => {
    expect(toSpeakable("Mirá https://example.com/a/b?c=1 o escribí a ana@mail.com 🚀")).toBe("Mirá o escribí a");
  });

  it("keeps table cells as a list", () => {
    expect(toSpeakable("| a | b |\n|---|---|\n| 1 | 2 |")).toContain("1");
  });
});

describe("cleanTranscript", () => {
  it("drops the captions whisper invents over silence", () => {
    expect(cleanTranscript(" Subtítulos realizados por la comunidad de Amara.org ")).toBe("");
    expect(cleanTranscript("¡Gracias por ver el video!")).toBe("");
    expect(cleanTranscript("[Música]")).toBe("");
    expect(cleanTranscript("(aplausos)")).toBe("");
  });

  it("drops caption credits in any variant, and a prompt recited back", () => {
    expect(cleanTranscript("Subtítulos por la Iglesia de Jesucristo de los Santos de los Últimos días.")).toBe("");
    expect(cleanTranscript("¡Suscríbete!")).toBe("");
    expect(cleanTranscript("Subtítulos en español de la Iglesia de Jesucristo de los Santos de los Últimos días")).toBe("");
    expect(cleanTranscript("Transcripción realizada por la comunidad de Amara.org")).toBe("");
    const prompt = "Conversación con el Chief, el asistente de Kernl. ¿Qué tenés para hoy?";
    expect(cleanTranscript("el asistente de Kernl", prompt)).toBe("");
    expect(cleanTranscript("¿Qué tenés para hoy en la agenda del martes?", prompt)).toBe("¿Qué tenés para hoy en la agenda del martes?");
  });

  it("keeps real speech, even short", () => {
    expect(cleanTranscript("Gracias")).toBe("Gracias");
    expect(cleanTranscript("[Música] ¿Qué tengo para hoy?")).toBe("¿Qué tengo para hoy?");
  });
});

describe("measureLevels", () => {
  it("finds no voice in silence or steady noise", () => {
    expect(voicedFrames(silentWav(2))).toBe(0);
    const noise = silentWav(2);
    let seed = 1;
    for (let i = 0; i < 32_000; i++) {
      seed = (seed * 16807) % 2147483647;
      noise.writeInt16LE(Math.round(((seed / 2147483647) - 0.5) * 600), 44 + 2 * i);
    }
    expect(voicedFrames(noise)).toBeLessThan(5);
  });

  it("finds a loud voice and a quiet one alike", () => {
    expect(voicedFrames(speechLikeWav(8000))).toBeGreaterThan(30);
    // −35 dBFS-ish: the laptop mic that a fixed threshold used to throw away.
    const quiet = speechLikeWav(300);
    expect(voicedFrames(quiet)).toBeGreaterThan(30);
    const l = measureLevels(quiet);
    expect(l.speechDb).toBeLessThan(-35);
    expect(l.snrDb).toBeGreaterThan(30);
    expect(l.clippedPct).toBe(0);
  });

  it("reports clipping", () => {
    expect(measureLevels(speechLikeWav(32767)).clippedPct).toBeGreaterThan(0);
  });
});

describe("voice settings", () => {
  it("defaults to on, auto engines, Spanish", () => {
    const s = voiceSettingsFromEnv({});
    expect(s).toMatchObject({ enabled: true, sttEngine: "auto", ttsEngine: "auto", language: "es", ttsVoice: "", ttsSpeed: 1 });
  });

  it("reads the first voice module's variables", () => {
    const s = voiceSettingsFromEnv({
      VOICE_ENABLED: "false",
      VOICE_STT_PROVIDER: "local-whisper",
      VOICE_TTS_PROVIDER: "system",
      VOICE_DEFAULT_ID: "alloy",
    });
    expect(s).toMatchObject({ enabled: false, sttEngine: "whispercpp", ttsEngine: "auto", ttsVoice: "" });
  });

  it("parses loosely and falls back safely", () => {
    expect(parseSttEngine("GROQ")).toBe("groq");
    expect(parseSttEngine("nonsense")).toBe("auto");
    expect(parseTtsEngine("piper")).toBe("piper");
    expect(parseSpeed("1.25")).toBe(1.25);
    expect(parseSpeed("9")).toBe(1);
  });
});

describe("engine chains and voices", () => {
  it("auto walks local first", () => {
    expect(sttChain("auto")).toEqual(["whispercpp", "groq", "openai"]);
    expect(ttsChain("auto")).toEqual(["piper", "openai", "elevenlabs"]);
    expect(sttChain("groq")).toEqual(["groq"]);
  });

  it("gives each engine only a voice it knows", () => {
    const s = settings({ ttsVoice: "es_MX-claude-high" });
    expect(resolveVoice("piper", s)).toBe("es_MX-claude-high");
    expect(resolveVoice("openai", s)).toBe("nova");
    expect(resolveVoice("piper", settings({ ttsVoice: "onyx", language: "en" }))).toBe("en_US-lessac-medium");
    expect(resolveVoice("piper", settings())).toBe("es_AR-daniela-high");
  });

  it("cuts long text at a sentence end", () => {
    const text = "Una frase. ".repeat(500);
    const out = clampForSpeech(text, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(".")).toBe(true);
  });

  it("maps a Piper voice id to its upstream path", () => {
    expect(isPiperVoiceId("es_AR-daniela-high")).toBe(true);
    expect(isPiperVoiceId("../../etc/passwd")).toBe(false);
    expect(piperVoiceUrl("es_ES-mls_10246-low")).toBe(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/mls_10246/low/es_ES-mls_10246-low.onnx",
    );
    expect(() => piperVoiceUrl("es_AR/../x")).toThrow();
  });

  it("offers male and female voices from several Spanish-speaking countries", () => {
    const es = VOICE_CATALOG.filter((v) => v.engine === "piper" && v.lang === "es");
    expect(new Set(es.map((v) => v.country))).toEqual(new Set(["AR", "MX", "ES"]));
    expect(es.some((v) => v.gender === "male")).toBe(true);
    expect(es.some((v) => v.gender === "female")).toBe(true);
    for (const v of VOICE_CATALOG) {
      if (v.engine === "piper") {
        expect(isPiperVoiceId(v.id)).toBe(true);
        expect(v.id.startsWith(`${v.lang}_${v.country}-`)).toBe(true);
        expect(resolveVoice("piper", settings({ ttsVoice: v.id }))).toBe(v.id);
      } else {
        expect(resolveVoice("openai", settings({ ttsVoice: v.id }))).toBe(v.id);
      }
    }
    expect(new Set(VOICE_CATALOG.map((v) => v.id)).size).toBe(VOICE_CATALOG.length);
  });

  it("knows which hosts have a Piper build", () => {
    expect(piperArchiveName("linux", "x64")).toBe("piper_linux_x86_64.tar.gz");
    expect(piperArchiveName("win32", "x64")).toBe("piper_windows_amd64.zip");
    expect(piperArchiveName("win32", "arm64")).toBeNull();
  });

  it("silence never reaches an engine", async () => {
    const stt = new SttService(() => settings({ sttEngine: "groq" }));
    try {
      expect((await stt.transcribe(silentWav(2))).text).toBe("");
    } catch (err) {
      expect((err as Error).message).toMatch(/ffmpeg/); // no ffmpeg on this host
    }
  });

  it("an engine that is not connected is reported, not called", async () => {
    // Groq with no key: the chain has nothing to try. ffmpeg runs first, and
    // the silence gate after it, so the input is a real 1s tone.
    const stt = new SttService(() => settings({ sttEngine: "groq" }));
    const wav = speechLikeWav(4000);
    try {
      await stt.transcribe(wav);
      throw new Error("expected a failure");
    } catch (err) {
      const msg = (err as Error).message;
      if (/ffmpeg/.test(msg) && /not installed|failed to start/.test(msg)) return; // no ffmpeg here
      expect(msg).toContain("groq: not connected");
    }
  });
});

describe("/api/voice routes", () => {
  let server: KernelHttpServer;
  let base = "";
  let enabled = true;
  const calls: string[] = [];

  const fake = {
    get enabled() { return enabled; },
    transcribe: async (audio: Buffer, opts: { mimeType?: string }) => {
      calls.push(`transcribe:${audio.toString()}:${opts.mimeType}`);
      return { text: "hola chief", language: "es", engine: "whispercpp" };
    },
    synthesize: async (text: string, opts: { format?: string }) => {
      calls.push(`speak:${text}:${opts.format}`);
      return { audio: Buffer.from("OggS-fake"), format: opts.format ?? "ogg", engine: "piper" };
    },
    status: async () => ({ enabled, stt: { active: "whispercpp" }, tts: { active: "piper" } }),
    suggestedVoices: () => ["es_AR-daniela-high"],
  } as unknown as VoiceService;

  beforeEach(async () => {
    enabled = true;
    calls.length = 0;
    server = new KernelHttpServer({
      config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
    });
    registerVoiceRoutes(server, fake);
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => { await server.stop(); });

  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("transcribes base64 audio", async () => {
    const r = await post("/api/voice/transcribe", { audio: Buffer.from("abc").toString("base64"), mime_type: "audio/webm" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ text: "hola chief", engine: "whispercpp" });
    expect(calls).toEqual(["transcribe:abc:audio/webm"]);
  });

  it("rejects a missing body", async () => {
    expect((await post("/api/voice/transcribe", {})).status).toBe(400);
  });

  it("speaks the speakable text, ogg by default and mp3 on request", async () => {
    const r = await post("/api/voice/speak", { text: "**Hola** https://x.y" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/ogg");
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("OggS-fake");
    await post("/api/voice/speak", { text: "Hola", format: "mp3" });
    expect(calls).toEqual(["speak:Hola:ogg", "speak:Hola:mp3"]);
  });

  it("answers 409 while voice is off", async () => {
    enabled = false;
    expect((await post("/api/voice/transcribe", { audio: "YQ==" })).status).toBe(409);
    expect((await post("/api/voice/speak", { text: "hola" })).status).toBe(409);
    expect((await fetch(base + "/api/voice/status")).status).toBe(200);
  });
});

describe("Telegram voice routing", () => {
  it("hands the transport the voice service and answers voice with voice", async () => {
    let voiceHandler: ((t: string, c: { userId: string; chatId: string }) => Promise<{ text: string; speak?: string }>) | null = null;
    let gotService: unknown = null;
    let respond: boolean | undefined;
    const transport = {
      onMessage: () => {},
      onCallback: () => {},
      onVoice: (h: typeof voiceHandler) => { voiceHandler = h; },
      setVoiceService: (svc: unknown, r?: boolean) => { gotService = svc; respond = r; },
      send: async () => 1,
      editMessage: async () => {},
    };
    const registry = {
      getProvider: (id: string) => (id === "telegram" ? { getTransport: () => transport } : undefined),
    };
    const orchestrator = {
      handleMessage: async (text: string) => ({ text: `eco: ${text}` }),
      handleCallback: async () => ({ text: "" }),
    };
    const svc = { enabled: true };
    wireMessageRouting({
      notificationRegistry: registry as never,
      orchestrator: orchestrator as never,
      rateLimiter: {} as never,
      pairingManager: {} as never,
      agentService: null,
      agentExecutor: null,
      voiceService: svc as never,
    });
    expect(gotService).toBe(svc);
    expect(respond).toBe(true);
    const reply = await voiceHandler!("qué hay hoy", { userId: "1", chatId: "1" });
    expect(reply).toMatchObject({ text: "eco: qué hay hoy", speak: "eco: qué hay hoy" });
  });
});

/** 0.5 s silence, 1 s of 180 Hz at `amplitude`, 0.5 s silence — pauses, like speech. */
function speechLikeWav(amplitude: number): Buffer {
  const wav = silentWav(2);
  for (let i = 8_000; i < 24_000; i++) {
    wav.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 180 * i) / 16_000)), 44 + 2 * i);
  }
  return wav;
}

/** A silent 16 kHz mono PCM WAV of `seconds`. */
function silentWav(seconds: number): Buffer {
  const samples = Math.round(16_000 * seconds);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16_000, 24);
  buf.writeUInt32LE(32_000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

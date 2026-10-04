/**
 * HTTP surface of the voice module, used by the dashboard's mic button.
 *
 *   POST /api/voice/transcribe  { audio: base64, mime_type? } → { text, language, engine, ms }
 *   POST /api/voice/speak       { text, voice?, format? }      → audio/ogg (or mp3)
 *   GET  /api/voice/status                                     → VoiceStatus
 *
 * Audio travels as base64 JSON rather than a raw body: it rides the same
 * parseBody (and its size cap) as every other route, and the dashboard's
 * fetch interceptor already adds the bearer token to JSON calls. Two minutes
 * of opus is well under a megabyte.
 */

import { HttpError, type KernelHttpServer } from "../core/http-server.js";
import { log } from "../core/logger.js";
import { toSpeakable } from "./text.js";
import type { VoiceService } from "./service.js";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export function registerVoiceRoutes(server: KernelHttpServer, voice: VoiceService): void {
  const requireEnabled = () => {
    if (!voice.enabled) throw new HttpError(409, "Voice is turned off in Settings → AI → Voice");
  };

  server.route("GET", "/api/voice/status", async () => ({
    ...(await voice.status()),
    voices: voice.suggestedVoices(),
  }));

  server.route<{ audio?: string; mime_type?: string; language?: string }>("POST", "/api/voice/transcribe", async ({ body }) => {
    requireEnabled();
    if (!body.audio || typeof body.audio !== "string") throw new HttpError(400, "audio (base64) is required");
    const audio = Buffer.from(body.audio, "base64");
    if (audio.length === 0) throw new HttpError(400, "audio is empty");
    if (audio.length > MAX_AUDIO_BYTES) throw new HttpError(413, "audio is too long for one message");
    const started = Date.now();
    try {
      const r = await voice.transcribe(audio, {
        mimeType: body.mime_type,
        language: body.language || undefined,
      });
      return { text: r.text, language: r.language ?? null, engine: r.engine ?? null, ms: Date.now() - started, levels: r.levels ?? null };
    } catch (err) {
      log.warn(`Voice: transcribe failed — ${err instanceof Error ? err.message : String(err)}`);
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
  }, { requireBody: true });

  server.post("/api/voice/speak", async (req, res) => {
    try {
      requireEnabled();
      const body = await server.parseBody<{ text?: string; voice?: string; format?: string }>(req, 256 * 1024);
      const text = toSpeakable(String(body.text ?? ""));
      if (!text) throw new HttpError(400, "text is required");
      // Safari before 18.4 cannot play ogg/opus; the dashboard asks for mp3 there.
      const format = body.format === "mp3" ? "mp3" : "ogg";
      const r = await voice.synthesize(text, { voice: body.voice ? { voiceId: body.voice } : undefined, format });
      res.writeHead(200, {
        ...server.corsHeaders(req),
        "Content-Type": r.format === "ogg" ? "audio/ogg" : r.format === "mp3" ? "audio/mpeg" : "audio/wav",
        "Content-Length": String(r.audio.length),
        "Cache-Control": "no-store",
        "X-Voice-Engine": r.engine ?? "",
      });
      res.end(r.audio);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) log.warn(`Voice: speak failed — ${message}`);
      server.json(res, status, { error: message }, req);
    }
  });
}

/**
 * What happens to a file after upload, per kind.
 *
 * The rule throughout: `failed` only when the file itself cannot be read (or
 * breaks a limit, like a video over 180 s). A missing tool, a model that is
 * not downloaded, a frame grab that did not work — each is a warning on a
 * `ready` attachment, and the model gets whatever did come out.
 */

import { readdir } from "node:fs/promises";
import type { VoiceSettings } from "../../voice/types.js";
import type { AttachmentDerived, AttachmentRecord } from "./types.js";
import { extractDocx, extractPdf, extractPlainText } from "./extract.js";
import { ffmpeg, probe, runTool, ToolMissingError, type ProbeInfo } from "./media.js";
import { transcribeMedia } from "./transcribe.js";

/** The file is unusable; the attachment ends `failed` with this message. */
export class ProcessingFailure extends Error {
  constructor(message: string, readonly derived: AttachmentDerived = {}) {
    super(message);
    this.name = "ProcessingFailure";
  }
}

export interface ProcessContext {
  /** Data-dir-relative → absolute, jailed under the attachments dir. */
  absPath(rel: string): string;
  /** `attachments/<id>` */
  relDir: string;
  voice(): VoiceSettings;
  maxVideoSeconds: number;
}

/** Longest side of the image actually sent to models. */
const IMAGE_MAX_SIDE = 2048;
/** Width of a video frame. */
const FRAME_WIDTH = 768;
/** Frames per video: 12, never fewer than 8 nor more than 16. */
const FRAMES_MIN = 8;
const FRAMES_MAX = 16;
const FRAMES_TARGET = 12;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function frameCount(durationS: number): number {
  // round(duration / (duration / 12)) — the spacing is what scales with the
  // duration, not the count; kept as a function so the bounds live in one place.
  const raw = durationS > 0 ? Math.round(durationS / (durationS / FRAMES_TARGET)) : FRAMES_TARGET;
  return Math.min(FRAMES_MAX, Math.max(FRAMES_MIN, raw));
}

export async function processAttachment(rec: AttachmentRecord, ctx: ProcessContext): Promise<AttachmentDerived> {
  switch (rec.kind) {
    case "image": return processImage(rec, ctx);
    case "document": return processDocument(rec, ctx);
    case "video": return processVideo(rec, ctx);
  }
}

async function processImage(rec: AttachmentRecord, ctx: ProcessContext): Promise<AttachmentDerived> {
  const derived: AttachmentDerived = {};
  const warnings: string[] = [];
  const src = ctx.absPath(rec.path);

  try {
    const info = await probe(src);
    if (!info.hasVideo) throw new ProcessingFailure("la imagen no se pudo leer");
    derived.width = info.width;
    derived.height = info.height;
  } catch (err) {
    if (err instanceof ProcessingFailure) throw err;
    if (!(err instanceof ToolMissingError)) throw new ProcessingFailure(`la imagen no se pudo leer: ${message(err)}`);
    warnings.push("ffprobe no está disponible: no se leyeron las dimensiones");
  }

  // Re-encoded without metadata (EXIF, GPS) and fit inside 2048 px. JPEG and
  // WebP become JPEG; PNG and GIF (first frame) stay lossless as PNG.
  const ext = rec.mime === "image/jpeg" || rec.mime === "image/webp" ? "jpg" : "png";
  const outRel = `${ctx.relDir}/normalized.${ext}`;
  try {
    await ffmpeg([
      "-i", src,
      "-frames:v", "1",
      "-map_metadata", "-1",
      "-vf", `scale='min(${IMAGE_MAX_SIDE},iw)':'min(${IMAGE_MAX_SIDE},ih)':force_original_aspect_ratio=decrease`,
      ...(ext === "jpg" ? ["-q:v", "3"] : []),
      ctx.absPath(outRel),
    ]);
    derived.normalized = outRel;
  } catch (err) {
    warnings.push(err instanceof ToolMissingError
      ? "ffmpeg no está disponible: se envía la imagen original"
      : `no se pudo normalizar la imagen (${message(err)}); se envía la original`);
  }

  if (warnings.length) derived.warnings = warnings;
  return derived;
}

async function processDocument(rec: AttachmentRecord, ctx: ProcessContext): Promise<AttachmentDerived> {
  const src = ctx.absPath(rec.path);
  try {
    const out = rec.mime === "application/pdf"
      ? await extractPdf(src)
      : rec.mime.includes("wordprocessingml")
        ? await extractDocx(src)
        : await extractPlainText(src);
    const derived: AttachmentDerived = { text: out.text };
    if (out.pages !== undefined) derived.pages = out.pages;
    if (out.warnings.length) derived.warnings = out.warnings;
    return derived;
  } catch (err) {
    throw new ProcessingFailure(`el documento no se pudo leer: ${message(err)}`);
  }
}

/**
 * Duration when the container does not carry one — a WebM straight out of
 * MediaRecorder has none. Remuxing to null reads every packet header, which
 * is fast, and the last progress line has the time reached.
 */
async function measureDuration(src: string): Promise<number | undefined> {
  const { stderr } = await runTool("ffmpeg", ["-hide_banner", "-nostdin", "-i", src, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"]);
  const times = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const last = times.at(-1);
  if (!last) return undefined;
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

async function processVideo(rec: AttachmentRecord, ctx: ProcessContext): Promise<AttachmentDerived> {
  const derived: AttachmentDerived = {};
  const warnings: string[] = [];
  const src = ctx.absPath(rec.path);
  const finish = () => {
    if (warnings.length) derived.warnings = warnings;
    return derived;
  };

  let info: ProbeInfo;
  try {
    info = await probe(src);
  } catch (err) {
    if (!(err instanceof ToolMissingError)) throw new ProcessingFailure(`el video no se pudo leer: ${message(err)}`);
    warnings.push("ffprobe no está disponible: el video no se analizó");
    return finish();
  }
  if (!info.hasVideo) throw new ProcessingFailure("el archivo no tiene pista de video");
  derived.width = info.width;
  derived.height = info.height;

  let duration = info.duration_s;
  if (!duration) {
    duration = await measureDuration(src).catch(() => undefined);
    if (duration) duration = Math.round(duration * 100) / 100;
  }
  // Without a duration the length cap cannot be checked, and a long video
  // would slip through to whisper and the model.
  if (!duration) throw new ProcessingFailure("no se pudo determinar la duración del video", derived);
  derived.duration_s = duration;
  if (duration > ctx.maxVideoSeconds) {
    throw new ProcessingFailure(`el video dura ${Math.round(duration)} s; el máximo es ${ctx.maxVideoSeconds} s`, derived);
  }

  // Evenly spaced frames in one decoding pass.
  const n = frameCount(duration ?? 0);
  try {
    const rate = duration ? (n / duration).toFixed(4) : "1";
    await ffmpeg([
      "-i", src,
      "-an",
      "-vf", `fps=${rate},scale='min(${FRAME_WIDTH},iw)':-2`,
      "-frames:v", String(n),
      "-q:v", "4",
      ctx.absPath(`${ctx.relDir}/frame-%02d.jpg`),
    ]);
    const files = (await readdir(ctx.absPath(ctx.relDir))).filter((f) => /^frame-\d+\.jpg$/.test(f)).sort();
    if (files.length) derived.frames = files.map((f) => `${ctx.relDir}/${f}`);
    else warnings.push("no se pudieron extraer cuadros del video");
  } catch (err) {
    warnings.push(err instanceof ToolMissingError
      ? "ffmpeg no está disponible: el video va sin cuadros"
      : `no se pudieron extraer cuadros del video (${message(err)})`);
  }

  if (info.hasAudio) {
    try {
      const transcript = await transcribeMedia(src, ctx.voice());
      if (transcript) derived.transcript = transcript;
      else warnings.push("no se reconoció voz en el audio");
    } catch (err) {
      warnings.push(err instanceof ToolMissingError
        ? "whisper no está disponible: el video va sin transcripción"
        : `no se pudo transcribir el audio (${message(err)})`);
    }
  }

  return finish();
}

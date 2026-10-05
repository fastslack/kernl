/**
 * A video's audio → "[mm:ss] text" lines, through the same whisper.cpp the
 * voice module runs: same binary resolution (`core/media-tools.ts`), same
 * models dir, same model choice per machine. The only difference is the
 * output — voice wants one plain utterance, a video wants timestamps, so
 * whisper is asked for its default segment lines instead of `-nt`.
 *
 * It never downloads a model. The voice module fetches one on first use, and
 * that can be a gigabyte and a half; an attachment sitting in "processing"
 * behind that download would look broken. No model on disk → a warning and a
 * video with frames but no transcript.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { probeMediaTool } from "../../core/media-tools.js";
import { pickWhisperModel } from "../../voice/stt.js";
import { whisperModelPath, whisperModelsDir } from "../../voice/downloads.js";
import type { VoiceSettings } from "../../voice/types.js";
import { ffmpeg, runTool, ToolMissingError, WHISPER_TIMEOUT_MS } from "./media.js";

/** Fallback order when the preferred model is not downloaded. */
const MODEL_PREFERENCE = ["large-v3-turbo", "large-v3", "medium", "small", "base", "tiny"];

function localModel(preferred: string): string | null {
  if (existsSync(whisperModelPath(preferred))) return whisperModelPath(preferred);
  let files: string[] = [];
  try {
    files = readdirSync(whisperModelsDir()).filter((f) => /^ggml-.+\.bin$/.test(f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const rank = (f: string) => {
    const name = f.slice(5, -4);
    const i = MODEL_PREFERENCE.findIndex((m) => name === m || name.startsWith(`${m}-`) || name.startsWith(`${m}.`));
    return i < 0 ? MODEL_PREFERENCE.length : i;
  };
  files.sort((a, b) => rank(a) - rank(b));
  return path.join(whisperModelsDir(), files[0]);
}

/** "[00:01:02.340 --> 00:01:05.000]   text" → "[01:02] text". */
export function formatWhisperSegments(stdout: string): string {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\[(\d+):(\d{2}):(\d{2})[.,]\d+\s*-->\s*[^\]]+\]\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const text = m[4].trim();
    if (!text) continue;
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    out.push(`[${String(minutes).padStart(2, "0")}:${m[3]}] ${text}`);
  }
  return out.join("\n");
}

/**
 * Transcribe the audio track of a stored file. Throws `ToolMissingError` when
 * whisper-cli or ffmpeg is absent, a plain Error for anything else; the caller
 * turns both into warnings.
 */
export async function transcribeMedia(absPath: string, settings: VoiceSettings): Promise<string> {
  const status = await probeMediaTool("whisper-cli");
  if (!status.available) throw new ToolMissingError("whisper-cli", undefined);
  const model = localModel(await pickWhisperModel(settings));
  if (!model) throw new Error("no hay ningún modelo de whisper descargado (se baja al usar la voz por primera vez)");

  // Relative paths from the models dir, as voice and Cinema do: whisper-cli
  // on Windows mangles non-ASCII absolute paths.
  const cwd = whisperModelsDir();
  await mkdir(path.join(cwd, ".tmp"), { recursive: true });
  const dir = await mkdtemp(path.join(cwd, ".tmp", "attachment-"));
  const wav = path.join(dir, "in.wav");
  try {
    await ffmpeg(["-i", absPath, "-vn", "-map_metadata", "-1", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    const language = settings.language.trim().toLowerCase();
    const { stdout } = await runTool("whisper-cli", [
      "-m", path.relative(cwd, model),
      "-f", path.relative(cwd, wav),
      "-np",          // no progress or system info, just the segments
      "-sns",         // no "[Música]" tokens
      "-t", "4",
      "-l", language && language !== "auto" ? language : "auto",
    ], { cwd, timeoutMs: WHISPER_TIMEOUT_MS });
    return formatWhisperSegments(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

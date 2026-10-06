/**
 * ffmpeg / ffprobe / whisper-cli runs for attachment processing.
 *
 * Fixed argv arrays only, and the only path ever passed is the stored file's
 * (`attachments/<id>/…`), never the sender's filename. Every run has a hard
 * timeout: a crafted file that sends ffmpeg into a loop must not hold a queue
 * slot forever.
 */

import { spawn } from "node:child_process";
import { mediaToolBin, mediaToolError, type MediaTool } from "../../core/media-tools.js";

export const FFMPEG_TIMEOUT_MS = 60_000;
export const WHISPER_TIMEOUT_MS = 120_000;

/** The binary is not there (or will not start). Callers turn this into a warning. */
export class ToolMissingError extends Error {
  constructor(readonly tool: MediaTool, cause: unknown) {
    super(mediaToolError(tool, cause).message);
    this.name = "ToolMissingError";
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export function runTool(
  tool: MediaTool,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? FFMPEG_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(mediaToolBin(tool), args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(new ToolMissingError(tool, err));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdout.on("data", (c: Buffer) => {
      // Bounded: a transcript or a probe is small; anything bigger is noise.
      if (stdout.length < 4 * 1024 * 1024) stdout += c.toString();
    });
    proc.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += c.toString();
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === "ENOENT" || err.code === "EACCES" ? new ToolMissingError(tool, err) : err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${tool} superó el límite de ${Math.round(timeoutMs / 1000)} s`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${tool} terminó con código ${code}: ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`));
    });
  });
}

export interface ProbeInfo {
  duration_s?: number;
  width?: number;
  height?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** ffprobe a stored file: duration, first video stream's size, whether there is audio. */
export async function probe(absPath: string): Promise<ProbeInfo> {
  const { stdout } = await runTool("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height",
    "-of", "json",
    absPath,
  ]);
  const json = JSON.parse(stdout || "{}") as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const duration = Number.parseFloat(json.format?.duration ?? "");
  return {
    duration_s: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : undefined,
    width: video?.width,
    height: video?.height,
    hasVideo: !!video,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

/** ffmpeg with the quiet prefix every call here wants. */
export function ffmpeg(args: string[]): Promise<RunResult> {
  return runTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args]);
}

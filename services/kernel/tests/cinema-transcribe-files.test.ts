/**
 * The files the subtitle pipeline writes on its way to a transcript.
 *
 * Three Windows failures shaped this: whisper-cli aborting on a model path
 * under a non-ASCII user profile, a model download interrupted mid-write
 * leaving a truncated ggml-*.bin that was trusted forever after, and a failed
 * ffmpeg extract leaving its partial WAV in %TEMP%.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  downloadToFileAtomic,
  extractAudioToWav,
  whisperFileArgs,
} from "../assets/extensions/leisure/cinema/_module/transcribe.js";

describe("whisperFileArgs", () => {
  it("names files relative to the models dir, so a non-ASCII profile never reaches whisper", () => {
    const models = "C:\\Users\\José\\AppData\\Local\\Kernl\\data\\whisper-models";
    const args = whisperFileArgs(
      models,
      `${models}\\ggml-base.bin`,
      `${models}\\.tmp\\mtw-transcribe-Ab12Cd\\audio.wav`,
      path.win32,
    );
    expect(args).toEqual([
      "-m", "ggml-base.bin",
      "-f", ".tmp\\mtw-transcribe-Ab12Cd\\audio.wav",
      "-of", ".tmp\\mtw-transcribe-Ab12Cd\\audio.wav",
    ]);
    expect(args.every(a => /^[\x20-\x7e]*$/.test(a))).toBe(true);
  });

  it("works the same way on POSIX", () => {
    const args = whisperFileArgs("/data/whisper-models", "/data/whisper-models/ggml-small.bin", "/data/whisper-models/.tmp/x/audio.wav", path.posix);
    expect(args).toEqual(["-m", "ggml-small.bin", "-f", ".tmp/x/audio.wav", "-of", ".tmp/x/audio.wav"]);
  });
});

describe("downloadToFileAtomic", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "cinema-dl-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const body = (chunks: string[]) => new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });

  it("lands the whole file under its final name and leaves no .part", async () => {
    const target = path.join(dir, "ggml-base.bin");
    const seen: number[] = [];
    const n = await downloadToFileAtomic(
      new Response(body(["abc", "def"]), { headers: { "content-length": "6" } }),
      target,
      (received) => seen.push(received),
    );
    expect(n).toBe(6);
    expect(readFileSync(target, "utf8")).toBe("abcdef");
    expect(existsSync(`${target}.part`)).toBe(false);
    expect(seen).toEqual([3, 6]);
  });

  it("rejects a short body and leaves neither the model nor a .part", async () => {
    const target = path.join(dir, "ggml-base.bin");
    await expect(downloadToFileAtomic(
      new Response(body(["abc"]), { headers: { "content-length": "100" } }),
      target,
    )).rejects.toThrow(/truncated at 3 of 100/);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.part`)).toBe(false);
  });

  it("replaces a stale .part from an earlier interrupted run", async () => {
    const target = path.join(dir, "ggml-base.bin");
    writeFileSync(`${target}.part`, "leftover-garbage-from-last-time");
    await downloadToFileAtomic(new Response(body(["ok"])), target);
    expect(readFileSync(target, "utf8")).toBe("ok");
    expect(existsSync(`${target}.part`)).toBe(false);
  });
});

describe("extractAudioToWav cleanup", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "cinema-extract-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it.skipIf(!Bun.which("ffmpeg"))("removes its temp dir when ffmpeg fails", async () => {
    const missing = path.join(root, "does-not-exist.mp4");
    await expect(extractAudioToWav(missing, { tmpRoot: root })).rejects.toThrow(/ffmpeg exited/);
    expect(readdirSync(root)).toEqual([]);
  });
});

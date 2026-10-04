/**
 * Everything the local voice engines fetch on first use: whisper.cpp models,
 * Piper itself, and Piper voices. All of it lands under the data directory,
 * beside what Cinema already downloads, so one models dir serves both.
 *
 * Downloads are atomic (a `.part` renamed into place only when complete) and
 * deduplicated: two utterances arriving while the model is still coming down
 * wait on the same transfer instead of starting a second one.
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, readdir, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { log } from "../core/logger.js";

const execFileAsync = promisify(execFile);

/** Same directory Cinema uses, so a model downloaded for subtitles is reused. */
export function whisperModelsDir(): string {
  return process.env.WHISPERCPP_MODELS_DIR ?? path.join(process.cwd(), "data", "whisper-models");
}

export function piperDir(): string {
  return process.env.PIPER_DATA_DIR ?? path.join(process.cwd(), "data", "piper");
}

export function piperVoicesDir(): string {
  return process.env.PIPER_VOICES_DIR ?? path.join(process.cwd(), "data", "piper-voices");
}

const inflight = new Map<string, Promise<string>>();

/** Run `fetcher` once per `key` at a time; later callers share the promise. */
function once(key: string, fetcher: () => Promise<string>): Promise<string> {
  const hit = inflight.get(key);
  if (hit) return hit;
  const p = fetcher().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function downloadAtomic(url: string, target: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download ${r.status} for ${url}`);
  await mkdir(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  await rm(part, { force: true });
  const expected = Number.parseInt(r.headers.get("content-length") ?? "", 10);
  let received = 0;
  const out = createWriteStream(part);
  const closed = new Promise<void>((resolve, reject) => {
    out.on("close", () => resolve());
    out.on("error", reject);
  });
  closed.catch(() => {});
  try {
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!out.write(value)) await new Promise<void>((res) => out.once("drain", () => res()));
    }
  } finally {
    out.end();
    await closed;
  }
  // `<`, not `!==`: a gzip-encoded body decodes to more than its header says.
  if (Number.isFinite(expected) && expected > 0 && received < expected) {
    await rm(part, { force: true });
    throw new Error(`download truncated at ${received} of ${expected} bytes`);
  }
  await rename(part, target);
}

// ── whisper.cpp models ──────────────────────────────────────────────────

export function whisperModelPath(model: string): string {
  return path.join(whisperModelsDir(), `ggml-${model}.bin`);
}

export function ensureWhisperModel(model: string): Promise<string> {
  const target = whisperModelPath(model);
  if (existsSync(target)) return Promise.resolve(target);
  return once(target, async () => {
    log.info(`Voice: downloading ggml-${model}.bin (one-time)…`);
    await downloadAtomic(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`, target);
    log.info(`Voice: ggml-${model}.bin ready`);
    return target;
  });
}

// ── Piper binary ────────────────────────────────────────────────────────

const PIPER_RELEASE = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2";

/** The upstream archive for this host, or null when there is none. */
export function piperArchiveName(platform = process.platform, arch = process.arch): string | null {
  if (platform === "linux" && arch === "x64") return "piper_linux_x86_64.tar.gz";
  if (platform === "linux" && arch === "arm64") return "piper_linux_aarch64.tar.gz";
  if (platform === "darwin" && arch === "x64") return "piper_macos_x64.tar.gz";
  if (platform === "darwin" && arch === "arm64") return "piper_macos_aarch64.tar.gz";
  if (platform === "win32" && arch === "x64") return "piper_windows_amd64.zip";
  return null;
}

/** Where the downloaded binary sits (the archive unpacks into `piper/`). */
export function downloadedPiperBin(): string {
  return path.join(piperDir(), "piper", process.platform === "win32" ? "piper.exe" : "piper");
}

/**
 * Point PIPER_BIN at a previous download, so `mediaToolBin("piper")` — and
 * through it the doctor and status probes — find it without a search.
 */
export function adoptDownloadedPiper(): void {
  if (process.env.PIPER_BIN?.trim()) return;
  const bin = downloadedPiperBin();
  if (existsSync(bin)) process.env.PIPER_BIN = bin;
}

export function ensurePiperBinary(): Promise<string> {
  const bin = downloadedPiperBin();
  if (existsSync(bin)) return Promise.resolve(bin);
  const archive = piperArchiveName();
  if (!archive) {
    return Promise.reject(new Error(`No Piper build for ${process.platform}/${process.arch}; set PIPER_BIN to your own.`));
  }
  return once(bin, async () => {
    log.info(`Voice: downloading Piper (${archive}, one-time)…`);
    const dir = piperDir();
    const file = path.join(dir, archive);
    await downloadAtomic(`${PIPER_RELEASE}/${archive}`, file);
    // `tar` reads zip as well on Windows 10+ (bsdtar), so one command covers all.
    await execFileAsync("tar", ["-xf", archive], { cwd: dir, timeout: 120_000 });
    await rm(file, { force: true });
    if (!existsSync(bin)) {
      const found = await readdir(dir).catch(() => [] as string[]);
      throw new Error(`Piper archive unpacked without ${path.basename(bin)} (found: ${found.join(", ")})`);
    }
    if (process.platform !== "win32") await chmod(bin, 0o755).catch(() => {});
    process.env.PIPER_BIN = bin;
    log.info(`Voice: Piper ready at ${bin}`);
    return bin;
  });
}

// ── Piper voices ────────────────────────────────────────────────────────

/** Voices worth offering by default, one per language Kernl speaks. */
export const DEFAULT_PIPER_VOICES: Record<string, string> = {
  es: "es_AR-daniela-high",
  en: "en_US-lessac-medium",
  pt: "pt_BR-faber-medium",
  fr: "fr_FR-siwis-medium",
  it: "it_IT-paola-medium",
  de: "de_DE-thorsten-medium",
};

/** One voice the Settings picker offers. */
export interface VoiceOption {
  id: string;
  engine: "piper" | "openai";
  /** Display name — the upstream speaker name, not a description. */
  name: string;
  gender: "female" | "male" | "neutral";
  /** ISO 3166 country of the accent; empty for OpenAI's accent-neutral voices. */
  country: string;
  /** ISO 639-1. */
  lang: string;
  quality: "high" | "medium" | "low";
}

/**
 * The voices offered in Settings. Gender is MEASURED, not guessed from the
 * name (es_MX-claude-high is a woman): each Piper voice was synthesized and
 * its median pitch taken with YIN — under ~150 Hz male, over ~170 Hz female.
 * es_ES-sharvard's second speaker is labelled "F" upstream but measures
 * 132 Hz, so only its first speaker is offered.
 */
export const VOICE_CATALOG: VoiceOption[] = [
  { id: "es_AR-daniela-high", engine: "piper", name: "Daniela", gender: "female", country: "AR", lang: "es", quality: "high" },
  { id: "es_MX-claude-high", engine: "piper", name: "Claude", gender: "female", country: "MX", lang: "es", quality: "high" },
  { id: "es_MX-ald-medium", engine: "piper", name: "Ald", gender: "male", country: "MX", lang: "es", quality: "medium" },
  { id: "es_ES-davefx-medium", engine: "piper", name: "Dave", gender: "male", country: "ES", lang: "es", quality: "medium" },
  { id: "es_ES-sharvard-medium", engine: "piper", name: "Sharvard", gender: "male", country: "ES", lang: "es", quality: "medium" },
  { id: "es_ES-carlfm-x_low", engine: "piper", name: "Carl", gender: "male", country: "ES", lang: "es", quality: "low" },
  { id: "es_ES-mls_10246-low", engine: "piper", name: "MLS 10246", gender: "female", country: "ES", lang: "es", quality: "low" },
  { id: "es_ES-mls_9972-low", engine: "piper", name: "MLS 9972", gender: "female", country: "ES", lang: "es", quality: "low" },
  { id: "en_US-lessac-medium", engine: "piper", name: "Lessac", gender: "female", country: "US", lang: "en", quality: "medium" },
  { id: "en_US-amy-medium", engine: "piper", name: "Amy", gender: "female", country: "US", lang: "en", quality: "medium" },
  { id: "en_US-ryan-high", engine: "piper", name: "Ryan", gender: "male", country: "US", lang: "en", quality: "high" },
  { id: "en_US-joe-medium", engine: "piper", name: "Joe", gender: "male", country: "US", lang: "en", quality: "medium" },
  { id: "en_GB-alba-medium", engine: "piper", name: "Alba", gender: "female", country: "GB", lang: "en", quality: "medium" },
  { id: "en_GB-alan-medium", engine: "piper", name: "Alan", gender: "male", country: "GB", lang: "en", quality: "medium" },
  // OpenAI's voices speak every language with the same timbre.
  { id: "nova", engine: "openai", name: "Nova", gender: "female", country: "", lang: "", quality: "high" },
  { id: "shimmer", engine: "openai", name: "Shimmer", gender: "female", country: "", lang: "", quality: "high" },
  { id: "coral", engine: "openai", name: "Coral", gender: "female", country: "", lang: "", quality: "high" },
  { id: "sage", engine: "openai", name: "Sage", gender: "female", country: "", lang: "", quality: "high" },
  { id: "alloy", engine: "openai", name: "Alloy", gender: "neutral", country: "", lang: "", quality: "high" },
  { id: "ash", engine: "openai", name: "Ash", gender: "male", country: "", lang: "", quality: "high" },
  { id: "echo", engine: "openai", name: "Echo", gender: "male", country: "", lang: "", quality: "high" },
  { id: "fable", engine: "openai", name: "Fable", gender: "male", country: "", lang: "", quality: "high" },
  { id: "onyx", engine: "openai", name: "Onyx", gender: "male", country: "", lang: "", quality: "high" },
];

const VOICE_ID = /^([a-z]{2,3})_([A-Z]{2})-([A-Za-z0-9_]+)-(x_low|low|medium|high)$/;

export function isPiperVoiceId(id: string): boolean {
  return VOICE_ID.test(id);
}

/** `es_AR-daniela-high` → its path inside rhasspy/piper-voices. */
export function piperVoiceUrl(id: string): string {
  const m = VOICE_ID.exec(id);
  if (!m) throw new Error(`Not a Piper voice id: "${id}" (expected e.g. es_AR-daniela-high)`);
  const [, lang, region, name, quality] = m;
  return `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${lang}_${region}/${name}/${quality}/${id}.onnx`;
}

export function piperVoicePath(id: string): string {
  return path.join(piperVoicesDir(), `${id}.onnx`);
}

export function ensurePiperVoice(id: string): Promise<string> {
  const target = piperVoicePath(id);
  if (existsSync(target) && existsSync(`${target}.json`)) return Promise.resolve(target);
  return once(target, async () => {
    const url = piperVoiceUrl(id);
    log.info(`Voice: downloading Piper voice ${id} (one-time)…`);
    await downloadAtomic(`${url}.json`, `${target}.json`);
    await downloadAtomic(url, target);
    log.info(`Voice: ${id} ready`);
    return target;
  });
}

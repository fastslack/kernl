/**
 * One door onto @huggingface/transformers, so its model cache lands somewhere
 * that survives.
 *
 * Left alone, transformers.js caches downloaded weights in
 * `<the package's own directory>/.cache/` — it derives the path from
 * `import.meta.url` of its `env.js` and reads no environment variable for it
 * (checked against the shipped copy: there is not a single `process.env` in
 * that file). Inside a native package that resolves to somewhere nobody would
 * choose:
 *
 *   /Applications/Kernl-0.2.3-arm64.app/Contents/Resources/node_modules/
 *     @huggingface/transformers/.cache/
 *
 * Two things follow, and both were live. The app bundle is not reliably
 * writable — /opt/kernl never is — so the first subtitle job can fail on
 * EACCES after ffmpeg has already spent minutes pulling the audio down. And
 * on macOS the bundle path carries the version, so an upgrade orphans the
 * cache: every release re-downloads the model and leaves the old copy inside
 * an app that is about to be deleted.
 *
 * Everything else the kernel downloads at runtime lives under `<data>/data`
 * (whisper.cpp's ggml models included, see WHISPERCPP_MODELS_DIR). This puts
 * the ONNX weights beside them.
 *
 * Import this instead of the package. Reaching for
 * `await import("@huggingface/transformers")` directly gets the default back.
 */

import path from "node:path";
import { log } from "./logger.js";

/**
 * Where the weights go. `TRANSFORMERS_CACHE_DIR` overrides, for anyone who
 * wants the cache on another disk or shared between installs.
 *
 * Relative to cwd because every launcher chdirs into the user's data directory
 * before starting the kernel — the same anchor `WHISPERCPP_MODELS_DIR` falls
 * back to.
 */
export function transformersCacheDir(): string {
  const override = process.env.TRANSFORMERS_CACHE_DIR?.trim();
  if (override) return override;
  return path.join(process.cwd(), "data", "transformers-cache");
}

let configured = false;

/**
 * The package, with `env.cacheDir` pointed at ours.
 *
 * The module is a singleton per resolved path, so the first caller through
 * here settles it for the process — but extensions are compiled into their own
 * bundles and each carries its own copy of this file, so the flag is a
 * per-bundle optimisation, not the mechanism. Setting the same value twice is
 * harmless; what matters is that nothing reaches `pipeline()` before one of
 * these calls has run.
 */
export async function loadTransformers(): Promise<typeof import("@huggingface/transformers")> {
  const mod = await import("@huggingface/transformers");
  if (!configured) {
    const dir = transformersCacheDir();
    mod.env.cacheDir = dir;
    configured = true;
    log.debug(`transformers: model cache at ${dir}`);
  }
  return mod;
}

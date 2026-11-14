/**
 * Which onnxruntime execution provider the in-process embeddings run on.
 *
 * The candidates come from the platform and from what the shipped
 * onnxruntime-node binding says it carries (`listSupportedBackends()`):
 *
 *   macOS    → CoreML (Apple GPU / Neural Engine), bundled in the darwin build
 *   Windows  → DirectML, bundled in the win32 build
 *   Linux x64→ CUDA — only when the CUDA provider library is present;
 *              packaging/stage-payload.sh prunes it from the desktop payload,
 *              so on most installs this falls through to CPU
 *   anything → CPU, always last
 *
 * "Available" is not "faster". Measured on Apple Silicon with ORT 1.21 and
 * paraphrase-multilingual-MiniLM-L12-v2, CoreML splits the graph into 97
 * partitions (the 250k-token embedding table is over CoreML's input limit)
 * and runs 2.5–5× SLOWER than the CPU provider. So the choice is calibrated:
 * each accelerator that opens a session is timed against the CPU on a few
 * probe texts and kept only when it wins. The verdict is cached per
 * (model, dtype, platform, ORT version) so calibration runs once, not on
 * every boot. Any accelerator that fails to load or to run is skipped, and
 * the CPU is always the floor — no configuration is needed.
 *
 * `EMBEDDINGS_DEVICE` (auto | cpu | coreml | dml | cuda) pins a device for
 * anyone who wants to; a pinned accelerator that fails still falls back to
 * the CPU.
 *
 * Everything here is pure or takes its effects as arguments, so the
 * selection logic is tested with the providers mocked
 * (tests/embeddings-device.test.ts).
 */

export type EmbeddingDevice = "cpu" | "coreml" | "dml" | "cuda";

export const ACCELERATORS: readonly EmbeddingDevice[] = ["coreml", "dml", "cuda"];

/** Accelerators worth trying on this platform, best first. */
export function acceleratorsFor(platform: NodeJS.Platform | string, arch: string): EmbeddingDevice[] {
  switch (platform) {
    case "darwin":
      return ["coreml"];
    case "win32":
      return ["dml"];
    case "linux":
      // onnxruntime-node publishes CUDA only for linux/x64.
      return arch === "x64" ? ["cuda"] : [];
    default:
      return [];
  }
}

/**
 * Ordered devices to consider: the platform's accelerators the binding
 * actually carries, then the CPU. `supported` is what
 * `ort.listSupportedBackends()` returned, or null when it could not be read
 * (older bindings) — then the platform list is trusted and a missing
 * provider surfaces as a failed session, which also falls back.
 */
export function candidateDevices(
  platform: NodeJS.Platform | string,
  arch: string,
  supported: ReadonlyArray<{ name: string }> | null,
): EmbeddingDevice[] {
  const names = supported ? new Set(supported.map((b) => b.name.toLowerCase())) : null;
  const accel = acceleratorsFor(platform, arch).filter((d) => !names || names.has(d));
  return [...accel, "cpu"];
}

/** `EMBEDDINGS_DEVICE`, normalized. Unknown values mean "auto". */
export function parseDeviceOverride(raw: string | undefined): EmbeddingDevice | "auto" {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "cpu" || v === "coreml" || v === "dml" || v === "cuda") return v;
  if (v === "directml") return "dml";
  if (v === "gpu") return "auto";
  return "auto";
}

/** The `executionProviders` list handed to the ORT session for a device. */
export function executionProvidersFor(device: EmbeddingDevice): string[] {
  return device === "cpu" ? ["cpu"] : [device, "cpu"];
}

export interface DeviceTrial {
  device: EmbeddingDevice;
  /** Milliseconds per probe text, when the device loaded and ran. */
  msPerText?: number;
  /** Why the device was not usable. */
  error?: string;
}

export interface DeviceChoice {
  device: EmbeddingDevice;
  /** One human line: why this device. Goes to the log and the /models note. */
  reason: string;
  trials: DeviceTrial[];
}

/**
 * Pick a device. `measure(device)` opens a session on that device, embeds the
 * probe texts and resolves with ms/text — or rejects when the provider is
 * missing or broken. It is only called for devices that need deciding.
 *
 * Rules:
 *  - a pinned device is tried alone; if it fails, CPU;
 *  - with a single candidate (CPU only) nothing is measured;
 *  - otherwise CPU is the baseline, and an accelerator wins only when it is
 *    at least `margin` faster (default 10 %), so noise does not flip the
 *    choice toward the more fragile path.
 */
export async function chooseDevice(opts: {
  candidates: EmbeddingDevice[];
  override?: EmbeddingDevice | "auto";
  measure: (device: EmbeddingDevice) => Promise<number>;
  margin?: number;
}): Promise<DeviceChoice> {
  const margin = opts.margin ?? 0.1;
  const override = opts.override ?? "auto";
  const trials: DeviceTrial[] = [];

  const attempt = async (device: EmbeddingDevice): Promise<DeviceTrial> => {
    try {
      const ms = await opts.measure(device);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error(`invalid timing ${ms}`);
      const t = { device, msPerText: ms };
      trials.push(t);
      return t;
    } catch (err) {
      const t = { device, error: err instanceof Error ? err.message : String(err) };
      trials.push(t);
      return t;
    }
  };

  if (override !== "auto") {
    if (override === "cpu") return { device: "cpu", reason: "pinned by EMBEDDINGS_DEVICE", trials };
    const t = await attempt(override);
    if (t.error === undefined) return { device: override, reason: "pinned by EMBEDDINGS_DEVICE", trials };
    return { device: "cpu", reason: `${override} pinned but unusable (${short(t.error)}); using CPU`, trials };
  }

  const accels = opts.candidates.filter((d) => d !== "cpu");
  if (accels.length === 0) return { device: "cpu", reason: "no GPU provider on this platform", trials };

  const cpu = await attempt("cpu");
  let best: DeviceTrial | null = null;
  for (const d of accels) {
    const t = await attempt(d);
    if (t.error !== undefined) continue;
    if (cpu.msPerText === undefined || t.msPerText! < cpu.msPerText * (1 - margin)) {
      if (!best || t.msPerText! < best.msPerText!) best = t;
    }
  }
  if (best) {
    const vs = cpu.msPerText !== undefined ? ` vs CPU ${fmt(cpu.msPerText)}` : "";
    return { device: best.device, reason: `${best.device} ${fmt(best.msPerText!)}${vs}`, trials };
  }
  const losers = trials
    .filter((t) => t.device !== "cpu")
    .map((t) => (t.error !== undefined ? `${t.device} failed: ${short(t.error)}` : `${t.device} ${fmt(t.msPerText!)}`))
    .join(", ");
  const base = cpu.msPerText !== undefined ? `CPU ${fmt(cpu.msPerText)}` : "CPU";
  return { device: "cpu", reason: `${base} was fastest (${losers})`, trials };
}

/** Cache key for a calibration verdict. */
export function calibrationKey(p: { model: string; dtype: string; platform: string; arch: string; ortVersion: string }): string {
  return `${p.model}|${p.dtype}|${p.platform}-${p.arch}|ort-${p.ortVersion}`;
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)} ms/text`;
}

function short(s: string): string {
  const one = s.split("\n")[0];
  return one.length > 120 ? `${one.slice(0, 117)}…` : one;
}

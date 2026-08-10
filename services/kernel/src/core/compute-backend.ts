/**
 * Which compute backend this machine can actually run, and what that means
 * for a transcribe job.
 *
 * Subtitles are the one feature where hardware decides the experience. The
 * same two-hour film is four minutes on a desktop with a discrete GPU and
 * closer to an hour on a passively-cooled laptop, and Kernl ships to both.
 * Hardcoding either target picks a loser: tuned for the laptop, the desktop
 * leaves an order of magnitude unused; tuned for the desktop, the laptop
 * swaps or dies.
 *
 * Two halves, deliberately split:
 *
 *   - `probeComputeBackend()` touches the machine (spawns, reads /dev) and is
 *     cached. Impure, hard to test, kept as small as possible.
 *   - `chooseTranscribePlan()` is a pure function of the probe result. All the
 *     policy — which model, which quant, how many threads — lives here where a
 *     test can pin it without a GPU in the runner.
 *
 * ── Why probing the binary beats probing the OS ─────────────────────────────
 *
 * A GPU being present is three independent facts, and a transcribe job needs
 * all three:
 *
 *   1. the hardware and its driver exist,
 *   2. the binary was *compiled* with that ggml backend,
 *   3. inside Docker, the device was passed through to the container.
 *
 * `nvidia-smi` answers only the first. A CPU-only build of whisper.cpp on a
 * machine with a 4070 passes an nvidia-smi check and then transcribes on the
 * CPU anyway — which is exactly the state this module was written to stop
 * shipping silently. ggml's `GGML_BACKEND_DL` build compiles each backend to
 * its own shared object and loads whatever the host supports at runtime, so
 * asking the binary to enumerate its devices answers all three at once.
 *
 * The device listing is best-effort: not every build exposes it, and the flag
 * has moved between ggml releases. When it is unavailable we fall back to
 * platform and driver evidence, which is weaker (it can claim a GPU the binary
 * cannot use) — so the fallback is reported as `inferred`, and callers that
 * care can refuse to trust it.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ComputeBackend = "cuda" | "metal" | "vulkan" | "cpu";

export interface ComputeCapabilities {
  /** Best backend this host can actually run. */
  backend: ComputeBackend;
  /** Human-readable device name, when we learned one. */
  device?: string;
  /**
   * Dedicated video memory in MB. Undefined when unknown — which is the common
   * case for Vulkan and for unified-memory Macs, and must not be read as zero.
   */
  vramMB?: number;
  /** Physical cores, floored at 1. The thread budget comes from this. */
  cores: number;
  /** System RAM in MB. The ceiling when there is no GPU. */
  ramMB: number;
  /**
   * How we know. `enumerated` = the binary listed the device itself, so all
   * three facts hold. `inferred` = driver/platform evidence only; the binary
   * may still lack the backend. `none` = nothing found, CPU it is.
   */
  evidence: "enumerated" | "inferred" | "none";
}

/** Whether we are inside a container — see media-tools.ts for why this file. */
const IN_CONTAINER = existsSync("/.dockerenv");

// ── Probing ────────────────────────────────────────────────────────────────

/**
 * Read which backends actually loaded, from a whisper.cpp run's stderr.
 *
 * There is no flag for this. `--list-devices` is llama.cpp's, not
 * whisper.cpp's; asking for it here prints the usage banner and exits 1, and
 * that banner contains the word "device" (`-dev N`, `--ov-e-device`), so a
 * naive probe reads the refusal as a successful enumeration reporting no GPU.
 * That is worse than no detection at all: it is a confident false negative
 * that would pin a GPU machine to the CPU path.
 *
 * What ggml does emit, on every run, is one line per backend it managed to
 * dlopen:
 *
 *   ggml_cuda_init: found 1 CUDA devices (Total VRAM: 11900 MiB):
 *   load_backend: loaded CUDA backend from /usr/local/lib/libggml-cuda.so
 *   load_backend: loaded Vulkan backend from /usr/local/lib/libggml-vulkan.so
 *   load_backend: loaded CPU backend from /usr/local/lib/libggml-cpu-zen4.so
 *
 * That is ground truth — hardware, driver, compiled backend and container
 * passthrough all had to hold for the line to print. So detection is not a
 * separate probe at all: it is a side effect of the first real job, parsed
 * here and cached. Pure, so a test can feed it a captured log.
 */
export function parseBackendLog(stderr: string): {
  backends: ComputeBackend[];
  vramMB?: number;
  device?: string;
} {
  const backends: ComputeBackend[] = [];
  for (const m of stderr.matchAll(/load_backend: loaded (\w+) backend/gi)) {
    const name = (m[1] ?? "").toLowerCase();
    if (name === "cuda" || name === "metal" || name === "vulkan" || name === "cpu") {
      if (!backends.includes(name)) backends.push(name);
    }
  }

  // Total VRAM, not free — sizing a model against free memory is how you get
  // an OOM the second time the job runs.
  const vram = /Total VRAM:\s*(\d+)\s*MiB/i.exec(stderr);
  // Vulkan names the adapter; CUDA's line does not.
  const dev = /ggml_vulkan: \d+ = ([^|]+?)\s*\|/.exec(stderr);

  return {
    backends,
    vramMB: vram ? Number.parseInt(vram[1] ?? "", 10) : undefined,
    device: dev?.[1]?.trim(),
  };
}

/** Preference order once we know what loaded. See `pickBackend` for the why. */
const BACKEND_RANK: ComputeBackend[] = ["cuda", "metal", "vulkan", "cpu"];

/**
 * Best of the backends that actually loaded.
 *
 * CUDA first, on long-form evidence. Measured on an RTX 4070 with
 * large-v3-turbo over an 80.5-minute film (165 encode windows):
 *
 *   CUDA    47 s wall, 57.28 ms per encode, 1199 cues
 *   Vulkan  54 s wall, 70.84 ms per encode, 1204 cues
 *
 * A short clip says the opposite — on 11 seconds of audio Vulkan reported
 * 11.5-13.4 ms per encode against CUDA's 60-68 ms, reproducibly, which is
 * where an earlier version of this comment got its ranking. That measurement
 * was wrong: over a single encode the Vulkan timer appears to capture the
 * submit rather than the completion, and the cost only surfaces once 165 of
 * them queue up. The lesson is in the file for the next person to benchmark a
 * GPU here — one window is not a measurement.
 *
 * The gap is real but small: 15% of wall clock on a feature-length film,
 * seven seconds. Both backends produce the same transcript to within five
 * cues. So this ordering decides which to *use* when both are present; it is
 * not the argument for which to *ship* — see the packaging notes, where 15%
 * does not buy 900 MB of CUDA runtime and NVIDIA-only coverage.
 */
export function pickBackend(loaded: ComputeBackend[]): ComputeBackend {
  for (const b of BACKEND_RANK) if (loaded.includes(b)) return b;
  return "cpu";
}

/**
 * Fold an observed run into the cache, upgrading `inferred` to `enumerated`.
 * Call this with the stderr of any completed transcribe.
 */
export function recordObservedBackends(stderr: string): ComputeCapabilities | null {
  const seen = parseBackendLog(stderr);
  if (seen.backends.length === 0) return null;
  const prev = cached?.caps;
  const caps: ComputeCapabilities = {
    cores: prev?.cores ?? Math.max(1, os.cpus()?.length ?? 1),
    ramMB: prev?.ramMB ?? Math.round(os.totalmem() / (1024 * 1024)),
    backend: pickBackend(seen.backends),
    device: seen.device ?? prev?.device,
    vramMB: seen.vramMB ?? prev?.vramMB,
    evidence: "enumerated",
  };
  cached = { at: Date.now(), caps };
  return caps;
}

/** NVIDIA driver present and answering, with its VRAM. Host-level evidence. */
async function probeNvidia(): Promise<{ device: string; vramMB: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5_000 },
    );
    const [name, mem] = (stdout.split("\n")[0] ?? "").split(",").map((s) => s.trim());
    if (!name) return null;
    const vramMB = Number.parseInt(mem ?? "", 10);
    return { device: name, vramMB: Number.isFinite(vramMB) ? vramMB : 0 };
  } catch {
    return null;
  }
}

/**
 * Apple Silicon. Every arm64 Mac has a Metal GPU sharing system memory, so
 * there is nothing to detect beyond the architecture — and no separate VRAM
 * figure to report.
 */
function isAppleSilicon(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

/** A Vulkan-capable GPU (AMD, Intel iGPU) — loader plus a render node. */
function hasVulkanEvidence(): boolean {
  if (process.platform === "linux") {
    return existsSync("/dev/dri/renderD128") && existsSync("/usr/share/vulkan");
  }
  // On Windows the loader is always present; absence of proof is not proof of
  // absence, so we stay conservative and let the CPU path take it.
  return false;
}

let cached: { at: number; caps: ComputeCapabilities } | null = null;
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Detect the best usable backend. Never throws; the honest floor is CPU.
 *
 * `bin` should be the transcribe binary that will actually run the job, so the
 * answer reflects that build's backends rather than some other one's.
 */
export async function probeComputeBackend(
  bin: string,
  opts: { fresh?: boolean } = {},
): Promise<ComputeCapabilities> {
  const now = Date.now();
  if (!opts.fresh && cached && now - cached.at < CACHE_TTL_MS) return cached.caps;

  const cores = Math.max(1, os.cpus()?.length ?? 1);
  const ramMB = Math.round(os.totalmem() / (1024 * 1024));
  const base = { cores, ramMB };

  // An explicit override always wins: someone debugging a bad driver needs to
  // be able to force the CPU path without uninstalling anything.
  const forced = process.env.KERNEL_COMPUTE_BACKEND?.trim().toLowerCase();
  if (forced === "cuda" || forced === "metal" || forced === "vulkan" || forced === "cpu") {
    const caps: ComputeCapabilities = { ...base, backend: forced, evidence: "inferred" };
    cached = { at: now, caps };
    return caps;
  }

  // Everything below is inference from driver and platform evidence. It can
  // claim a GPU the binary cannot actually use, which is why it never reports
  // `enumerated` and why `chooseTranscribePlan` refuses to size a job for a
  // GPU on this evidence alone. The real answer arrives on the first run, via
  // `recordObservedBackends`.
  let caps: ComputeCapabilities;
  const nv = await probeNvidia();
  if (nv) {
    caps = { ...base, backend: "cuda", device: nv.device, vramMB: nv.vramMB, evidence: "inferred" };
  } else if (isAppleSilicon()) {
    caps = { ...base, backend: "metal", device: "Apple Silicon", evidence: "inferred" };
  } else if (hasVulkanEvidence()) {
    caps = { ...base, backend: "vulkan", evidence: "inferred" };
  } else {
    caps = { ...base, backend: "cpu", evidence: "none" };
  }

  cached = { at: now, caps };
  return caps;
}

/** Clear the probe cache. Tests, and the doctor's --fresh path. */
export function resetComputeBackendCache(): void {
  cached = null;
}

// ── Policy (pure) ──────────────────────────────────────────────────────────

export type Quant = "f16" | "q8_0" | "q5_0";

export interface TranscribePlan {
  /** GGUF quantization to fetch. Smaller costs accuracy, monotonically. */
  quant: Quant;
  /** Whether the job should ask for GPU offload at all. */
  useGpu: boolean;
  /** Threads for the decode. Ignored by the GPU paths. */
  threads: number;
  /** One clause naming the reason, for the log line and the doctor. */
  rationale: string;
}

/**
 * Memory a quantization needs resident, in MB, for a 0.6B-parameter model.
 * Deliberately padded over the file size: weights are the floor, activations
 * and the KV-equivalent state ride on top.
 */
const QUANT_FOOTPRINT_MB: Record<Quant, number> = {
  f16: 1400,
  q8_0: 900,
  q5_0: 650,
};

/**
 * Pick a plan from capabilities. Pure — no spawning, no clock, no env.
 *
 * The policy in one sentence: spend memory when there is memory to spend, and
 * never plan a job that needs more than half of what the machine has, because
 * the other half is running the rest of Kernl.
 */
export function chooseTranscribePlan(caps: ComputeCapabilities): TranscribePlan {
  // Leave one core for the event loop and ffmpeg, and stop at 8 — ggml's
  // decode stops scaling well past that, and oversubscribing a shared box
  // costs more than the last thread returns.
  const threads = Math.max(1, Math.min(8, caps.cores - 1));

  const gpu = caps.backend !== "cpu";

  // `inferred` evidence means the driver is there but we never confirmed the
  // binary can use it. Planning a GPU job on that is how you get a silent
  // fallback to CPU with a model sized for a GPU. Take the GPU, but size the
  // model as if it might not happen.
  const trustGpu = gpu && caps.evidence === "enumerated";

  if (trustGpu && caps.backend === "metal") {
    // Unified memory: the GPU budget is the system budget, so RAM decides.
    const quant: Quant = caps.ramMB >= 16_000 ? "f16" : "q8_0";
    return {
      quant,
      useGpu: true,
      threads,
      rationale: `Metal on ${caps.device ?? "Apple Silicon"} (${Math.round(caps.ramMB / 1024)} GB unified)`,
    };
  }

  if (trustGpu) {
    // Discrete GPU. Unknown VRAM is treated as small on purpose: guessing high
    // fails at allocation, guessing low merely leaves speed unclaimed.
    const vram = caps.vramMB ?? 0;
    const quant: Quant = vram >= 6_000 ? "f16" : vram >= 2_000 ? "q8_0" : "q5_0";
    const where = caps.device ?? caps.backend.toUpperCase();
    return {
      quant,
      useGpu: true,
      threads,
      rationale: vram
        ? `${caps.backend.toUpperCase()} on ${where} (${Math.round(vram / 1024)} GB VRAM)`
        : `${caps.backend.toUpperCase()} on ${where} (VRAM unknown — sized conservatively)`,
    };
  }

  // CPU, or a GPU we do not trust. Half the RAM is the budget.
  const budget = caps.ramMB / 2;
  const quant: Quant =
    budget >= QUANT_FOOTPRINT_MB.f16 && caps.cores >= 8
      ? "f16"
      : budget >= QUANT_FOOTPRINT_MB.q8_0
        ? "q8_0"
        : "q5_0";

  const why =
    gpu && !trustGpu
      ? `${caps.backend.toUpperCase()} driver found but the binary did not confirm it — running on CPU`
      : IN_CONTAINER && caps.evidence === "enumerated"
        ? "no GPU visible to the container"
        : "no GPU detected";

  return {
    quant,
    useGpu: false,
    threads,
    rationale: `${why} — ${threads} threads, ${Math.round(caps.ramMB / 1024)} GB RAM`,
  };
}

/** One line for the startup log and the doctor output. */
export function describePlan(caps: ComputeCapabilities, plan: TranscribePlan): string {
  return `transcribe: ${plan.quant}${plan.useGpu ? " on GPU" : ""} — ${plan.rationale}`;
}

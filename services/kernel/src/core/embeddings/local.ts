/**
 * In-process embeddings — @huggingface/transformers on onnxruntime-node.
 *
 * This is the default embeddings provider: no LM Studio, no API key, no
 * network after the first model download. It runs on the GPU when the
 * platform has an execution provider that is actually faster for the model
 * (see device.ts — calibrated, cached, CPU as the floor) and on the CPU
 * otherwise.
 *
 * Default model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`.
 *  - 384 dimensions — the size the experience graph's and chat knowledge's
 *    vector indexes are built for, so switching to it needs no index rebuild.
 *  - Multilingual (50+ languages, trained on paraphrase pairs); Kernl's
 *    learnings and memory are mostly Spanish, which the previous fallback
 *    (all-MiniLM-L6-v2, English-only) handled poorly.
 *  - The same weights LM Studio serves as
 *    `text-embedding-paraphrase-multilingual-minilm-l12-v2.gguf`: on 200 real
 *    learnings the fp32 ONNX vectors match the GGUF ones at cosine 0.997
 *    median (0.92 worst case, long texts the two truncate differently).
 *  - ~100 texts/s on one Apple Silicon CPU (fp32, length-sorted batches of 8).
 *  - fp32 (464 MB download) rather than q8 (113 MB): q8 is ~40 % faster but
 *    changed 13 % of top-5 neighbours on the same sample. `EMBEDDINGS_LOCAL_DTYPE=q8`
 *    trades that back.
 *
 * `EMBEDDINGS_LOCAL_MODEL` picks another entry of LOCAL_MODELS (or any HF
 * feature-extraction repo with ONNX weights; `EMBEDDINGS_LOCAL_DIM` then
 * gives its size).
 *
 * The weights go to `<data>/data/transformers-cache` (transformers-cache.ts).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../logger.js";
import { loadTransformers, transformersCacheDir } from "../transformers-cache.js";
import type { EmbedOptions, EmbeddingsClient } from "./client.js";
import {
  calibrationKey,
  candidateDevices,
  chooseDevice,
  executionProvidersFor,
  parseDeviceOverride,
  type DeviceChoice,
  type EmbeddingDevice,
} from "./device.js";

export interface LocalModelSpec {
  id: string;
  dim: number;
  /** Prefixes for asymmetric encoders (E5). Symmetric models leave them out. */
  queryPrefix?: string;
  passagePrefix?: string;
}

/** Known-good local models. The first is the default. */
export const LOCAL_MODELS: readonly LocalModelSpec[] = [
  { id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", dim: 384 },
  // Stronger retrieval on MTEB, same size and vocabulary, but asymmetric and
  // not compatible with vectors made by the paraphrase model.
  { id: "Xenova/multilingual-e5-small", dim: 384, queryPrefix: "query: ", passagePrefix: "passage: " },
  // The pre-0.5.2 fallback. English-centric; kept so a pinned install still loads.
  { id: "Xenova/all-MiniLM-L6-v2", dim: 384 },
];

export const DEFAULT_LOCAL_MODEL = LOCAL_MODELS[0].id;


export function resolveLocalModel(env: NodeJS.ProcessEnv = process.env): LocalModelSpec {
  const id = env.EMBEDDINGS_LOCAL_MODEL?.trim();
  if (!id) return LOCAL_MODELS[0];
  const known = LOCAL_MODELS.find((m) => m.id === id);
  if (known) return known;
  const dim = parseInt(env.EMBEDDINGS_LOCAL_DIM ?? "384", 10);
  return { id, dim: Number.isFinite(dim) && dim > 0 ? dim : 384 };
}

type FeaturePipeline = ((
  texts: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>) & { dispose?: () => Promise<void> };

/** What /api/embeddings/status shows about the local provider. */
export interface LocalEmbeddingsStatus {
  model: string;
  dim: number;
  dtype: string;
  /** null until the first embed() loads the model. */
  device: EmbeddingDevice | null;
  deviceReason: string | null;
  loaded: boolean;
}

/**
 * CPU threads per ORT session. ORT defaults to every core, which a background
 * re-embed would then hold for minutes on a desktop that is also running
 * agents; MiniLM-sized models gain little past four. `EMBEDDINGS_LOCAL_THREADS`
 * overrides.
 */
export function cpuThreads(env: NodeJS.ProcessEnv = process.env, cores = os.availableParallelism?.() ?? os.cpus().length): number {
  const pinned = parseInt(env.EMBEDDINGS_LOCAL_THREADS ?? "", 10);
  if (Number.isFinite(pinned) && pinned > 0) return pinned;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

/** Texts per ORT run. Batches are sorted by length first, so padding stays small. */
const SUB_BATCH = 8;

/** Probe texts for device calibration: mid-length, mixed languages, like real learnings. */
const PROBE_TEXTS = [
  "Antes de tocar la base de datos de producción, hacé una copia y probá la migración sobre esa copia.",
  "When the build fails only on CI, compare the lockfile with the installed node_modules first.",
  "Los recordatorios que llegan de madrugada se posponen hasta las nueve de la mañana del usuario.",
  "Prefer small, reviewable commits; each one should leave the test suite green.",
  "Si el proveedor devuelve 429, esperá el tiempo que indica el encabezado Retry-After antes de reintentar.",
  "A learning that keeps losing confidence after several runs is retired by the nightly sweep.",
  "Para buscar por significado, el vector de la consulta tiene que venir del mismo modelo que los guardados.",
  "Summaries for the daily digest should name the project and stay under five lines.",
];

interface CalibrationCache {
  [key: string]: { device: EmbeddingDevice; reason: string; at: string };
}

function calibrationFile(): string {
  return path.join(transformersCacheDir(), "embeddings-device.json");
}

function readCalibration(): CalibrationCache {
  try {
    return JSON.parse(readFileSync(calibrationFile(), "utf8")) as CalibrationCache;
  } catch {
    return {};
  }
}

function writeCalibration(key: string, entry: CalibrationCache[string] | null): void {
  try {
    const all = readCalibration();
    if (entry) all[key] = entry;
    else delete all[key];
    mkdirSync(path.dirname(calibrationFile()), { recursive: true });
    writeFileSync(calibrationFile(), JSON.stringify(all, null, 2));
  } catch (err) {
    log.debug(`embeddings/local: could not write device calibration — ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface OrtInfo {
  supported: Array<{ name: string }> | null;
  version: string;
}

async function ortInfo(): Promise<OrtInfo> {
  try {
    const ort = (await import("onnxruntime-node")) as unknown as {
      listSupportedBackends?: () => Array<{ name: string }>;
      env?: { versions?: Record<string, string> };
      default?: { listSupportedBackends?: () => Array<{ name: string }>; env?: { versions?: Record<string, string> } };
    };
    const api = ort.listSupportedBackends ? ort : ort.default ?? ort;
    const supported = api.listSupportedBackends ? api.listSupportedBackends() : null;
    const v = api.env?.versions;
    return { supported, version: v?.node ?? v?.common ?? "unknown" };
  } catch {
    return { supported: null, version: "unknown" };
  }
}

export class LocalEmbeddings implements EmbeddingsClient {
  readonly provider = "local" as const;
  readonly model: string;
  readonly dim: number;
  readonly dtype: string;
  private readonly spec: LocalModelSpec;
  private loading: Promise<FeaturePipeline> | null = null;
  private device: EmbeddingDevice | null = null;
  private deviceReason: string | null = null;

  constructor(spec: LocalModelSpec = resolveLocalModel(), dtype = process.env.EMBEDDINGS_LOCAL_DTYPE?.trim() || "fp32") {
    this.spec = spec;
    this.model = spec.id;
    this.dim = spec.dim;
    this.dtype = dtype;
  }

  async available(): Promise<boolean> {
    // The weights download on first use; treat the backend as available.
    // A failed download surfaces from embed().
    return true;
  }

  status(): LocalEmbeddingsStatus {
    return {
      model: this.model,
      dim: this.dim,
      dtype: this.dtype,
      device: this.device,
      deviceReason: this.deviceReason,
      loaded: this.device !== null,
    };
  }

  /** Load now instead of on the first embed(), so the device line reaches the log at boot. */
  warmUp(): Promise<void> {
    return this.pipeline().then(() => undefined);
  }

  private async open(device: EmbeddingDevice): Promise<FeaturePipeline> {
    const { pipeline } = await loadTransformers();
    return (await pipeline("feature-extraction", this.model, {
      dtype: this.dtype as "fp32",
      session_options: { executionProviders: executionProvidersFor(device), intraOpNumThreads: cpuThreads() },
    } as Parameters<typeof pipeline>[2])) as unknown as FeaturePipeline;
  }

  private pipeline(): Promise<FeaturePipeline> {
    if (!this.loading) {
      this.loading = this.load().catch((err) => {
        this.loading = null; // a failed download is retried on the next call
        throw err;
      });
    }
    return this.loading;
  }

  private async load(): Promise<FeaturePipeline> {
    const t0 = Date.now();
    const info = await ortInfo();
    const override = parseDeviceOverride(process.env.EMBEDDINGS_DEVICE);
    const candidates = candidateDevices(process.platform, process.arch, info.supported);
    const key = calibrationKey({
      model: this.model, dtype: this.dtype, platform: process.platform, arch: process.arch, ortVersion: info.version,
    });

    const opened = new Map<EmbeddingDevice, FeaturePipeline>();
    const openKeep = async (d: EmbeddingDevice) => {
      let p = opened.get(d);
      if (!p) {
        p = await this.open(d);
        opened.set(d, p);
      }
      return p;
    };

    let choice: DeviceChoice | null = null;
    const cached = override === "auto" ? readCalibration()[key] : undefined;
    if (cached && candidates.includes(cached.device)) {
      choice = { device: cached.device, reason: `${cached.reason} (calibrated ${cached.at.slice(0, 10)})`, trials: [] };
    } else {
      choice = await chooseDevice({
        candidates,
        override,
        measure: async (d) => {
          const p = await openKeep(d);
          for (const text of PROBE_TEXTS) await p([text], { pooling: "mean", normalize: true }); // warm-up (compiles on accelerators)
          const s = performance.now();
          for (const text of PROBE_TEXTS) await p([text], { pooling: "mean", normalize: true });
          return (performance.now() - s) / PROBE_TEXTS.length;
        },
      });
      if (override === "auto" && choice.trials.length > 0) {
        writeCalibration(key, { device: choice.device, reason: choice.reason, at: new Date().toISOString() });
      }
    }

    let device = choice.device;
    let reason = choice.reason;
    let pipe: FeaturePipeline;
    try {
      pipe = await openKeep(device);
    } catch (err) {
      if (device === "cpu") throw err;
      // A cached verdict whose provider no longer loads (driver gone, payload changed).
      writeCalibration(key, null);
      reason = `${device} failed to load (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); using CPU`;
      device = "cpu";
      pipe = await openKeep("cpu");
    }
    for (const [d, p] of opened) {
      if (d !== device) await p.dispose?.().catch(() => {});
    }

    this.device = device;
    this.deviceReason = reason;
    log.info(
      `embeddings/local: ${this.model} (${this.dim}d, ${this.dtype}) on ${device.toUpperCase()} — ${reason} ` +
      `[loaded in ${Date.now() - t0} ms; candidates ${candidates.join(", ")}]`,
    );
    return pipe;
  }

  /** An accelerator that loaded but fails at run time: move to the CPU for good. */
  private async demoteToCpu(err: unknown): Promise<FeaturePipeline> {
    const was = this.device;
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    log.warn(`embeddings/local: ${was} failed at run time (${msg.slice(0, 160)}) — switching to CPU`);
    const old = this.loading ? await this.loading.catch(() => null) : null;
    const cpu = this.open("cpu");
    this.loading = cpu;
    const p = await cpu;
    await old?.dispose?.().catch(() => {});
    this.device = "cpu";
    this.deviceReason = `${was} failed at run time; using CPU`;
    return p;
  }

  async embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    const prefix = opts?.inputType === "query" ? this.spec.queryPrefix : this.spec.passagePrefix;
    const input = prefix ? texts.map((t) => prefix + t) : texts;

    let p = await this.pipeline();
    const run = async (pipe: FeaturePipeline) => {
      const out: number[][] = new Array(input.length);
      const order = input.map((_, i) => i).sort((a, b) => input[a].length - input[b].length);
      for (let i = 0; i < order.length; i += SUB_BATCH) {
        const idx = order.slice(i, i + SUB_BATCH);
        const r = (await pipe(idx.map((j) => input[j]), { pooling: "mean", normalize: true })).tolist();
        if (r.length !== idx.length) {
          throw new Error(`local embeddings shape mismatch: expected ${idx.length}, got ${r.length}`);
        }
        idx.forEach((j, k) => { out[j] = r[k]; });
      }
      return out;
    };
    try {
      return await run(p);
    } catch (err) {
      if (this.device === null || this.device === "cpu") throw err;
      p = await this.demoteToCpu(err);
      return run(p);
    }
  }
}

const shared = new Map<string, LocalEmbeddings>();

/**
 * One instance per (model, dtype) for the whole kernel. The fp32 model holds
 * ~500 MB once loaded; a provider switch that lands on the same local model
 * (local → auto with every link down, the chat fallback, the chain's local
 * link) must reuse the loaded session, not open a second one.
 */
export function sharedLocalEmbeddings(spec: LocalModelSpec = resolveLocalModel(), dtype = process.env.EMBEDDINGS_LOCAL_DTYPE?.trim() || "fp32"): LocalEmbeddings {
  const key = `${spec.id}|${dtype}`;
  let c = shared.get(key);
  if (!c) {
    c = new LocalEmbeddings(spec, dtype);
    shared.set(key, c);
  }
  return c;
}

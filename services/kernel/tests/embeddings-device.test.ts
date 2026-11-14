import { describe, it, expect } from "bun:test";
import {
  acceleratorsFor,
  calibrationKey,
  candidateDevices,
  chooseDevice,
  executionProvidersFor,
  parseDeviceOverride,
  type EmbeddingDevice,
} from "../src/core/embeddings/device.js";

/** A mocked provider set: ms/text per device, or an Error when it cannot load. */
function providers(map: Partial<Record<EmbeddingDevice, number | Error>>) {
  const calls: EmbeddingDevice[] = [];
  const measure = async (d: EmbeddingDevice) => {
    calls.push(d);
    const v = map[d];
    if (v === undefined) throw new Error(`${d} not mocked`);
    if (v instanceof Error) throw v;
    return v;
  };
  return { measure, calls };
}

describe("candidate devices", () => {
  it("maps each platform to its accelerator, CPU last", () => {
    expect(acceleratorsFor("darwin", "arm64")).toEqual(["coreml"]);
    expect(acceleratorsFor("win32", "x64")).toEqual(["dml"]);
    expect(acceleratorsFor("win32", "arm64")).toEqual(["dml"]);
    expect(acceleratorsFor("linux", "x64")).toEqual(["cuda"]);
    expect(acceleratorsFor("linux", "arm64")).toEqual([]);
    expect(acceleratorsFor("freebsd", "x64")).toEqual([]);
  });

  it("keeps only the accelerators the binding carries", () => {
    // What onnxruntime-node 1.21 reports on macOS arm64.
    const mac = [{ name: "cpu" }, { name: "webgpu" }, { name: "coreml" }];
    expect(candidateDevices("darwin", "arm64", mac)).toEqual(["coreml", "cpu"]);
    // A Linux payload whose CUDA provider was pruned.
    expect(candidateDevices("linux", "x64", [{ name: "cpu" }])).toEqual(["cpu"]);
    expect(candidateDevices("win32", "x64", [{ name: "cpu" }, { name: "dml" }])).toEqual(["dml", "cpu"]);
  });

  it("trusts the platform when the binding cannot be asked", () => {
    expect(candidateDevices("linux", "x64", null)).toEqual(["cuda", "cpu"]);
  });

  it("parses EMBEDDINGS_DEVICE", () => {
    expect(parseDeviceOverride(undefined)).toBe("auto");
    expect(parseDeviceOverride("")).toBe("auto");
    expect(parseDeviceOverride(" CPU ")).toBe("cpu");
    expect(parseDeviceOverride("directml")).toBe("dml");
    expect(parseDeviceOverride("coreml")).toBe("coreml");
    expect(parseDeviceOverride("gpu")).toBe("auto");
    expect(parseDeviceOverride("tpu")).toBe("auto");
  });

  it("always keeps the CPU behind an accelerator in the session", () => {
    expect(executionProvidersFor("cpu")).toEqual(["cpu"]);
    expect(executionProvidersFor("coreml")).toEqual(["coreml", "cpu"]);
  });

  it("keys calibration by model, dtype, platform and ORT version", () => {
    expect(calibrationKey({ model: "m", dtype: "fp32", platform: "darwin", arch: "arm64", ortVersion: "1.21.0" }))
      .toBe("m|fp32|darwin-arm64|ort-1.21.0");
  });
});

describe("chooseDevice", () => {
  it("measures nothing when only the CPU is available", async () => {
    const p = providers({});
    const c = await chooseDevice({ candidates: ["cpu"], measure: p.measure });
    expect(c.device).toBe("cpu");
    expect(p.calls).toEqual([]);
    expect(c.reason).toContain("no GPU provider");
  });

  it("keeps the CPU when the accelerator is slower (CoreML on Apple Silicon)", async () => {
    const p = providers({ cpu: 9.5, coreml: 47 });
    const c = await chooseDevice({ candidates: ["coreml", "cpu"], measure: p.measure });
    expect(c.device).toBe("cpu");
    expect(c.reason).toContain("fastest");
    expect(c.reason).toContain("coreml 47.0 ms/text");
  });

  it("takes the accelerator when it is clearly faster", async () => {
    const p = providers({ cpu: 10, dml: 3 });
    const c = await chooseDevice({ candidates: ["dml", "cpu"], measure: p.measure });
    expect(c.device).toBe("dml");
    expect(c.reason).toBe("dml 3.0 ms/text vs CPU 10.0 ms/text");
  });

  it("does not flip to the accelerator on noise", async () => {
    const p = providers({ cpu: 10, cuda: 9.5 });
    const c = await chooseDevice({ candidates: ["cuda", "cpu"], measure: p.measure });
    expect(c.device).toBe("cpu");
  });

  it("falls back to the CPU when the provider is missing or broken", async () => {
    const p = providers({ cpu: 10, cuda: new Error("libonnxruntime_providers_cuda.so: cannot open shared object file") });
    const c = await chooseDevice({ candidates: ["cuda", "cpu"], measure: p.measure });
    expect(c.device).toBe("cpu");
    expect(c.reason).toContain("cuda failed: libonnxruntime_providers_cuda.so");
    expect(c.trials.find((t) => t.device === "cuda")?.error).toBeTruthy();
  });

  it("still takes a working accelerator when the CPU probe failed", async () => {
    const p = providers({ cpu: new Error("oom"), dml: 4 });
    const c = await chooseDevice({ candidates: ["dml", "cpu"], measure: p.measure });
    expect(c.device).toBe("dml");
  });

  it("rejects nonsense timings", async () => {
    const p = providers({ cpu: 10, coreml: 0 });
    const c = await chooseDevice({ candidates: ["coreml", "cpu"], measure: p.measure });
    expect(c.device).toBe("cpu");
  });

  it("honours a pinned device without timing the CPU", async () => {
    const p = providers({ coreml: 50 });
    const c = await chooseDevice({ candidates: ["coreml", "cpu"], override: "coreml", measure: p.measure });
    expect(c.device).toBe("coreml");
    expect(p.calls).toEqual(["coreml"]);
    expect(c.reason).toContain("pinned");
  });

  it("falls back to the CPU when the pinned device fails", async () => {
    const p = providers({ dml: new Error("no DirectML adapter") });
    const c = await chooseDevice({ candidates: ["cpu"], override: "dml", measure: p.measure });
    expect(c.device).toBe("cpu");
    expect(c.reason).toContain("dml pinned but unusable (no DirectML adapter)");
  });

  it("pinning the CPU measures nothing", async () => {
    const p = providers({});
    const c = await chooseDevice({ candidates: ["coreml", "cpu"], override: "cpu", measure: p.measure });
    expect(c.device).toBe("cpu");
    expect(p.calls).toEqual([]);
  });
});

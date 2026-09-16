import { describe, it, expect, afterEach } from "bun:test";
import { getHost, installedHost, setHost, SDK_MAJOR, KernlHostVersionError } from "../src/sdk/host.js";
import { log as sdkLog } from "../src/sdk/log.js";
import { llm, getRequestContext, peering } from "../src/sdk/facades.js";
import { installTestHost, resetHost } from "../src/sdk/testing.js";
import { installKernlHost } from "../src/core/host-runtime.js";
import { setLogLevel } from "../src/core/logger.js";

// The preload installs the kernel host; every test puts it back.
const kernelHost = installedHost();
afterEach(() => setHost(kernelHost));

describe("extension host", () => {
  it("resolves facades to the installed host", () => {
    const infos: string[] = [];
    installTestHost({
      log: { debug() {}, info: (msg) => infos.push(msg), warn() {}, error() {} },
      getRequestContext: () => ({ callerAgentId: "agent-1", callerRunId: "run-1", callerDepth: 2 }),
    });

    sdkLog.info("hello");

    expect(infos).toEqual(["hello"]);
    expect(getRequestContext()).toEqual({ callerAgentId: "agent-1", callerRunId: "run-1", callerDepth: 2 });
  });

  it("falls back to the default host when none is installed", () => {
    resetHost();

    expect(peering()).toBeNull();
    expect(getRequestContext()).toEqual({ callerAgentId: "", callerRunId: "", callerDepth: 0 });
    expect(() => llm()).toThrow("Kernl host not installed: llm() only works inside a running kernel");
  });

  it("refuses a host that speaks another SDK major", () => {
    installTestHost({ sdk: SDK_MAJOR + 1 });

    expect(() => getHost()).toThrow(KernlHostVersionError);
  });

  it("applies the kernel's log level to logging through the SDK", () => {
    installKernlHost();
    const written: string[] = [];
    const realWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      setLogLevel("warn");
      sdkLog.info("sdk-info-below-threshold");
      sdkLog.warn("sdk-warn-at-threshold");
    } finally {
      process.stderr.write = realWrite;
      setLogLevel("info");
    }

    expect(written.some((w) => w.includes("sdk-info-below-threshold"))).toBe(false);
    expect(written.some((w) => w.includes("sdk-warn-at-threshold"))).toBe(true);
  });

  it("installs the kernel host once", () => {
    installKernlHost();
    const first = installedHost();
    installKernlHost();

    expect(installedHost()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

import { describe, it, expect, afterEach } from "bun:test";
import { getHost, installedHost, setHost, SDK_MAJOR, KernlHostVersionError } from "../src/sdk/host.js";
import { log as sdkLog } from "../src/sdk/log.js";
import { llm, getRequestContext, peering, instanceNostrIdentity, instanceKeyIsShared, registerPersona, friendPersonas } from "../src/sdk/facades.js";
import { NostrIdentity } from "../src/sdk/nostr-identity.js";
import type { PeeringService } from "../src/sdk/types.js";
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

  it("exposes the instance identity of the running peering service", () => {
    const instance = NostrIdentity.fromEd25519Seed(new Uint8Array(32).fill(7));
    const service = {
      identity: instance,
      instanceNostrIdentity: () => instance,
      instanceKeyIsShared: () => true,
    } as unknown as PeeringService;
    installTestHost({ peering: () => service });

    expect(instanceNostrIdentity()?.pubkeyHex).toBe(instance.pubkeyHex);
    expect(instanceKeyIsShared()).toBe(true);
  });

  it("tolerates an older core whose peering service lacks the accessors", () => {
    const instance = NostrIdentity.fromEd25519Seed(new Uint8Array(32).fill(8));
    installTestHost({ peering: () => ({ identity: instance }) as unknown as PeeringService });

    expect(() => instanceNostrIdentity()).not.toThrow();
    expect(instanceNostrIdentity()?.pubkeyHex).toBe(instance.pubkeyHex);
    expect(instanceKeyIsShared()).toBe(false);
  });

  it("hands the persona to the peering service and reads friends' personas back", () => {
    const persona = NostrIdentity.fromEd25519Seed(new Uint8Array(32).fill(9));
    const seen: Array<NostrIdentity | null> = [];
    const service = {
      registerPersona: (p: NostrIdentity | null) => { seen.push(p); },
      friendPersonas: () => ["ab".repeat(32)],
    } as unknown as PeeringService;
    installTestHost({ peering: () => service });

    expect(registerPersona(persona)).toBe(true);
    registerPersona(null);
    expect(seen).toEqual([persona, null]);
    expect(friendPersonas()).toEqual(["ab".repeat(32)]);
  });

  it("registers no persona on an older core or with peering off", () => {
    const persona = NostrIdentity.fromEd25519Seed(new Uint8Array(32).fill(10));
    installTestHost({ peering: () => ({ identity: persona }) as unknown as PeeringService });
    expect(registerPersona(persona)).toBe(false);
    expect(friendPersonas()).toEqual([]);

    installTestHost({ peering: () => null });
    expect(registerPersona(persona)).toBe(false);
    expect(friendPersonas()).toEqual([]);
    // Nothing is stashed process-wide for later: no key outlives the call.
    expect(Object.keys(globalThis).some((k) => k.toLowerCase().includes("persona"))).toBe(false);
  });

  it("has no instance identity while peering is off", () => {
    installTestHost({ peering: () => null });

    expect(instanceNostrIdentity()).toBeNull();
    expect(instanceKeyIsShared()).toBe(false);
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

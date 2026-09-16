/**
 * A provider can advertise a model its inference server never actually hosts —
 * NVIDIA NIM lists ~70 and serves fewer. The blocklist that hides such a model
 * from the picker existed, but only the chain-test endpoint ever filled it, so
 * a model that failed in a real chat stayed on offer for the next person. One
 * did: a conversation pinned to `deepseek-ai/deepseek-coder-6.7b-instruct`,
 * which NVIDIA lists to this day.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { ModelBlocklist } from "../src/core/llm/model-blocklist.js";
import { setModelFaultSink, reportModelFault } from "../src/core/llm/provider-health.js";

afterEach(() => { setModelFaultSink(null); });

describe("what counts as the model's fault", () => {
  it("retires the model when the classifier already said so", () => {
    expect(ModelBlocklist.reasonForFailure("model", "invalid params, unknown model 'x' (2013)")).toBe("not-found");
  });

  it("keeps recognising the wordings it always did", () => {
    expect(ModelBlocklist.reasonForFailure("transient", "no response in 20000ms")).toBe("timeout");
    expect(ModelBlocklist.reasonForFailure("transient", "404 model_not_found")).toBe("not-found");
  });

  it("never blames the model for the provider's own trouble", () => {
    expect(ModelBlocklist.reasonForFailure("auth", "401 unauthorized")).toBeNull();
    expect(ModelBlocklist.reasonForFailure("exhausted", "402 insufficient_quota")).toBeNull();
    expect(ModelBlocklist.reasonForFailure("rate-limit", "429 slow down")).toBeNull();
    expect(ModelBlocklist.reasonForFailure("transient", "socket hang up")).toBeNull();
  });
});

describe("reporting a model fault", () => {
  it("reaches the installed sink with everything it needs", () => {
    const seen: Array<[string, string, string, string]> = [];
    setModelFaultSink((slug, model, kind, message) => { seen.push([slug, model, kind, message]); });
    reportModelFault("nvidia", "deepseek-ai/deepseek-coder-6.7b-instruct", "model", "unknown model");
    expect(seen).toEqual([["nvidia", "deepseek-ai/deepseek-coder-6.7b-instruct", "model", "unknown model"]]);
  });

  it("is a no-op with no sink installed, which is every test and CLI tool", () => {
    expect(() => reportModelFault("nvidia", "m", "model", "boom")).not.toThrow();
  });

  it("says nothing when the call used the provider's own default", () => {
    const seen: string[] = [];
    setModelFaultSink((slug) => { seen.push(slug); });
    reportModelFault("nvidia", "", "model", "unknown model");
    expect(seen).toEqual([]);
  });
});

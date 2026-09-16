import { describe, it, expect } from "bun:test";
import { classifyProviderError } from "../src/core/llm/provider-errors.js";

const code = (msg: string, local = false) => classifyProviderError(new Error(msg), { local }).code;

describe("classifyProviderError", () => {
  it("auth", () => {
    expect(code("nvidia API error 401: Unauthorized")).toBe("auth");
    expect(code("HTTP 403: forbidden")).toBe("auth");
    expect(code('{"error":{"status":"ACCESS_TOKEN_TYPE_UNSUPPORTED"}}')).toBe("auth");
    expect(code("Incorrect API key provided: invalid_api_key")).toBe("auth");
  });
  it("no_session wins over the 401 inside a CLI message", () => {
    expect(code("LLM Claude-Code-SDK 401 not authenticated: Not logged in (run `claude` and /login)")).toBe("no_session");
  });
  it("quota", () => {
    expect(code("groq API error 429: rate_limit_exceeded")).toBe("quota");
    expect(code("deepseek API error 402: Insufficient Balance")).toBe("quota");
    expect(code("You exceeded your current quota")).toBe("quota");
  });
  it("model", () => {
    expect(code("nvidia API error 404: Function not found for account")).toBe("model");
    expect(code("The model `gpt-9` does not exist")).toBe("model");
    expect(code('Invalid model identifier "x" (model_not_found)')).toBe("model");
  });
  it("timeout", () => {
    expect(code("nvidia did not respond in 20000ms")).toBe("timeout");
    expect(code("The operation timed out.")).toBe("timeout");
    const abort = new Error("aborted"); abort.name = "TimeoutError";
    expect(classifyProviderError(abort).code).toBe("timeout");
  });
  it("unreachable only for local providers, network otherwise", () => {
    expect(code("Unable to connect. Is the computer able to access the url?", true)).toBe("unreachable");
    expect(code("connect ECONNREFUSED 127.0.0.1:11434", true)).toBe("unreachable");
    expect(code("connect ECONNREFUSED 1.2.3.4:443")).toBe("network");
    expect(code("getaddrinfo ENOTFOUND api.groq.com")).toBe("network");
  });
  it("unknown keeps the raw detail", () => {
    const r = classifyProviderError("something odd");
    expect(r).toEqual({ code: "unknown", detail: "something odd" });
  });
});

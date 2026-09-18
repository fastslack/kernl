import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  setCredentialSource, getProviderConfig, isConnected, listConnected,
  saveProviderConfig, clearProviderConfig, getStoredConfig,
} from "../src/core/llm/credentials.js";

let store: Record<string, Record<string, unknown>>;
function install() {
  store = {};
  setCredentialSource({
    loadConfig: (s) => ({ ...(store[s] ?? {}) }),
    saveConfig: (s, c) => { store[s] = { ...c }; return true; },
  });
}

describe("credentials", () => {
  beforeEach(install);
  afterEach(() => setCredentialSource(null));

  it("returns catalog defaults when nothing is stored", () => {
    const c = getProviderConfig("nvidia");
    expect(c).toEqual({
      apiKey: "", baseUrl: "https://integrate.api.nvidia.com/v1",
      model: "nvidia/nemotron-3-super-120b-a12b", region: "", oauthToken: "",
    });
    expect(isConnected("nvidia")).toBe(false);
  });

  it("stored key and model win; aliases resolve", () => {
    store.nvidia = { apiKey: "nvapi-x", defaultModel: "moonshotai/kimi-k2.6", connectedAt: "t" };
    expect(getProviderConfig("nim").apiKey).toBe("nvapi-x");
    expect(getProviderConfig("nvidia").model).toBe("moonshotai/kimi-k2.6");
    expect(isConnected("nim")).toBe(true);
  });

  it("ignores a stored baseUrl on providers whose URL is not editable", () => {
    store.nvidia = { baseUrl: "http://evil/v1" };
    expect(getProviderConfig("nvidia").baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    store.openai = { baseUrl: "http://localhost:8080/v1" };
    expect(getProviderConfig("openai").baseUrl).toBe("http://localhost:8080/v1");
  });

  it("uses the region's base URL", () => {
    store.minimax = { region: "china" };
    expect(getProviderConfig("minimax").baseUrl).toBe("https://api.minimax.cn/v1");
  });

  it("a key provider without a key is not connected even with connectedAt", () => {
    store.groq = { connectedAt: "t" };
    expect(isConnected("groq")).toBe(false);
    store.ollama = { connectedAt: "t" };
    expect(isConnected("ollama")).toBe(true);
  });

  it("lists connected providers in catalog order", () => {
    store.groq = { apiKey: "gsk_1", connectedAt: "t" };
    store.nvidia = { apiKey: "nvapi-1", connectedAt: "t" };
    expect(listConnected()).toEqual(["nvidia", "groq"]);
  });

  it("merges saves, deletes undefined, and clears", () => {
    saveProviderConfig("nvidia", { apiKey: "nvapi-1", connectedAt: "t" });
    saveProviderConfig("nim", { defaultModel: "m", connectedAt: undefined });
    expect(getStoredConfig("nvidia")).toEqual({ apiKey: "nvapi-1", defaultModel: "m" });
    clearProviderConfig("nvidia");
    expect(getStoredConfig("nvidia")).toEqual({});
  });

  it("is empty-safe without a source", () => {
    setCredentialSource(null);
    expect(getProviderConfig("groq").apiKey).toBe("");
    expect(saveProviderConfig("groq", { apiKey: "x" })).toBe(false);
    expect(getProviderConfig("unknown").baseUrl).toBe("");
  });
});

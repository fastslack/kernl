import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setCredentialSource } from "../src/core/llm/credentials.js";
import {
  installLegacyCredentialMirror, mirrorDeferredEnv, legacyToStoredPatch, legacyCredentialTarget,
} from "../src/core/llm/credentials-legacy.js";

let store: Record<string, Record<string, unknown>>;
beforeEach(() => {
  store = {};
  setCredentialSource({ loadConfig: (s) => ({ ...(store[s] ?? {}) }), saveConfig: (s, c) => { store[s] = { ...c }; return true; } });
});
afterEach(() => setCredentialSource(null));

const freshConfig = () => ({
  webIntel: { anthropicApiKey: "", openaiApiKey: "", grokApiKey: "", grokDefaultModel: "", nvidiaApiKey: "", nvidiaDefaultModel: "", lmstudioBaseUrl: "", braveApiKey: "b" },
  voice: { openaiApiKey: "" },
}) as any;

describe("legacy credential mirror", () => {
  it("reads legacy fields from the registry", () => {
    store.openai = { apiKey: "sk-1", connectedAt: "t" };
    store.nvidia = { apiKey: "nvapi-1", defaultModel: "m" };
    const c = freshConfig();
    installLegacyCredentialMirror(c);
    expect(c.webIntel.openaiApiKey).toBe("sk-1");
    expect(c.voice.openaiApiKey).toBe("sk-1");
    expect(c.webIntel.nvidiaApiKey).toBe("nvapi-1");
    expect(c.webIntel.nvidiaDefaultModel).toBe("m");
    expect(c.webIntel.grokDefaultModel).toBe("");
    expect(c.webIntel.braveApiKey).toBe("b");
  });

  it("an assignment saves into the registry instead of throwing", () => {
    const c = freshConfig();
    installLegacyCredentialMirror(c);
    c.webIntel.anthropicApiKey = "sk-ant-9";
    expect(store.claude.apiKey).toBe("sk-ant-9");
    expect(typeof store.claude.connectedAt).toBe("string");
  });

  it("LM Studio's URL only shows once it is connected", () => {
    const c = freshConfig();
    installLegacyCredentialMirror(c);
    expect(c.webIntel.lmstudioBaseUrl).toBe("");
    store.lmstudio = { connectedAt: "t", baseUrl: "http://host.docker.internal:1234/v1" };
    expect(c.webIntel.lmstudioBaseUrl).toBe("http://host.docker.internal:1234/v1");
  });

  it("mirrors the deferred Groq key into env and removes it when gone", () => {
    const env: NodeJS.ProcessEnv = {};
    store.groq = { apiKey: "gsk_1" };
    mirrorDeferredEnv(env);
    expect(env.GROQ_API_KEY).toBe("gsk_1");
    store.groq = {};
    mirrorDeferredEnv(env);
    expect(env.GROQ_API_KEY).toBeUndefined();
  });

  it("maps legacy env names to stored fields", () => {
    expect(legacyCredentialTarget("XAI_API_KEY")).toEqual({ slug: "grok", field: "apiKey" });
    expect(legacyCredentialTarget("OLLAMA_BASE_URL")).toBeUndefined();
    expect(legacyToStoredPatch("MINIMAX_BASE_URL", "https://api.minimax.cn/v1")?.patch).toEqual({ region: "china" });
    expect(legacyToStoredPatch("NVIDIA_DEFAULT_MODEL", "x")?.patch).toEqual({ defaultModel: "x" });
    expect(legacyToStoredPatch("NVIDIA_API_KEY", "k")?.patch.apiKey).toBe("k");
  });
});

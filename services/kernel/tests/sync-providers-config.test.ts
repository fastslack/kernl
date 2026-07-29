import { describe, it, expect } from "bun:test";
import { syncProvidersToKernelConfig } from "../src/core/llm/sync-config.js";

function regWith(configs: Record<string, Record<string, unknown>>) {
  return { loadConfig: (slug: string) => configs[slug] ?? {} };
}

describe("syncProvidersToKernelConfig", () => {
  it("mirrors provider settings_json into config.webIntel.*", () => {
    const config: any = { webIntel: {}, voice: {} };
    const reg = regWith({
      claude: { apiKey: "ant-key" },
      openai: { apiKey: "oai-key" },
      grok: { apiKey: "xai-key", defaultModel: "grok-4" },
      nvidia: { apiKey: "nv-key", defaultModel: "nv-model" },
      lmstudio: { baseUrl: "http://localhost:1234/v1" },
    });
    syncProvidersToKernelConfig(config, reg);
    expect(config.webIntel.anthropicApiKey).toBe("ant-key");
    expect(config.webIntel.openaiApiKey).toBe("oai-key");
    expect(config.voice.openaiApiKey).toBe("oai-key");
    expect(config.webIntel.grokApiKey).toBe("xai-key");
    expect(config.webIntel.grokDefaultModel).toBe("grok-4");
    expect(config.webIntel.nvidiaApiKey).toBe("nv-key");
    expect(config.webIntel.lmstudioBaseUrl).toBe("http://localhost:1234/v1");
  });

  it("leaves existing values untouched when provider config is empty", () => {
    const config: any = { webIntel: { anthropicApiKey: "keep" }, voice: {} };
    syncProvidersToKernelConfig(config, regWith({}));
    expect(config.webIntel.anthropicApiKey).toBe("keep");
  });
});

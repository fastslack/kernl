import { describe, it, expect } from "bun:test";
import { dispatchUninstall } from "../src/modules/extensions/installer.js";

// dispatchInstall imports the entry via dynamic import, which is awkward in a
// unit test; we cover the uninstall path (pure registry call) here and rely on
// the live smoke for the install path.
describe("installer llm-provider uninstall", () => {
  it("calls unregister on the llm provider registry", async () => {
    const calls: string[] = [];
    const deps: any = {
      db: { prepare: () => ({ run() {}, get() { return undefined; }, all() { return []; } }) },
      skillRegistry: null, agentsFacade: null, notificationRegistry: null,
      themeSubsystem: null, sandboxDriverRegistry: null,
      llmProviderRegistry: {
        registerDriverFromExtension() {},
        startProvider: async () => true,
        unregister: async (s: string) => { calls.push(s); },
      },
    };
    const manifest: any = { slug: "fakeprov", type: "llm-provider", category: "ai" };
    await dispatchUninstall(manifest, "/tmp/x", deps);
    expect(calls).toContain("fakeprov");
  });
});

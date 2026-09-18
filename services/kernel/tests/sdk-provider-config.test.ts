import { describe, it, expect, afterEach } from "bun:test";
import { installedHost, setHost } from "../src/sdk/host.js";
import { getProviderConfig } from "../src/sdk/facades.js";
import { installTestHost } from "../src/sdk/testing.js";

// The preload installs the kernel host; every test puts it back.
const kernelHost = installedHost();
afterEach(() => setHost(kernelHost));

describe("SDK getProviderConfig", () => {
  it("asks the installed host", () => {
    installTestHost({
      getProviderConfig: (slug) =>
        slug === "nvidia"
          ? { apiKey: "k", baseUrl: "b", model: "m", region: "", oauthToken: "" }
          : { apiKey: "", baseUrl: "", model: "", region: "", oauthToken: "" },
    });

    expect(getProviderConfig("nvidia").apiKey).toBe("k");
  });
});

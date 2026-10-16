import { describe, it, expect } from "bun:test";
import { encodeReturnState, returnTarget } from "../assets/extensions/integration/google-sync/_module/return-to.js";

describe("google oauth: back to the screen that asked", () => {
  it("round-trips a local dashboard URL and marks the result", () => {
    const s = encodeReturnState("http://127.0.0.1:5200/growth?project=heural");
    expect(returnTarget(s, "", "success")).toBe("http://127.0.0.1:5200/growth?project=heural&google_auth=success");
    expect(returnTarget(encodeReturnState("http://localhost:3086/growth"), "", "denied")).toBe("http://localhost:3086/growth?google_auth=denied");
  });
  it("only goes back to loopback or the public dashboard URL", () => {
    expect(encodeReturnState("https://evil.example/x")).toBe("");
    expect(returnTarget(encodeReturnState("https://kernl.example.org/growth"), "https://kernl.example.org", "success")).toBeNull();
    expect(encodeReturnState("https://kernl.example.org/growth", "https://kernl.example.org")).not.toBe("");
    expect(returnTarget("garbage", "", "success")).toBeNull();
    expect(returnTarget(null, "", "success")).toBeNull();
    expect(encodeReturnState("javascript:alert(1)")).toBe("");
  });
});

import { Database } from "bun:sqlite";
import { googleSyncOperations } from "../assets/extensions/integration/google-sync/_module/dashboard-rpc-actions.js";

describe("google.status tells the redirect URI to register", () => {
  it("is the kernel port's callback, with or without credentials", async () => {
    const config = { google: { clientId: "", clientSecret: "", callbackPort: 0 }, dashboard: { port: 3087 } } as never;
    const st = await googleSyncOperations({ db: new Database(":memory:") as never, config })["google.status"]({}) as { redirectUri: string; status: string };
    expect(st.status).toBe("disconnected");
    expect(st.redirectUri).toBe("http://localhost:3087/auth/google/callback");
  });
});

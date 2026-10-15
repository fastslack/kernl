import { describe, it, expect } from "bun:test";
import { GOOGLE_SCOPES } from "../assets/extensions/integration/google-sync/_module/auth.js";

describe("google scopes", () => {
  it("include read-only analytics and search console, and keep the existing ones", () => {
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/analytics.readonly");
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/webmasters.readonly");
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/gmail.send");
  });
});

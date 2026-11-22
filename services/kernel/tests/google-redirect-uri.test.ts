import { describe, it, expect } from "bun:test";
import { dashboardRedirectUri, publicDashboardBase } from "../assets/extensions/integration/google-sync/_module/auth.js";
import { googleRedirectUri } from "../src/modules/projects/google-link.js";

// Google sends the browser back to the redirect URI, so on an instance opened from another machine it
// must be the dashboard's public URL; everywhere else it stays the localhost address already registered.
const CASES: Array<[string, string]> = [
  ["", "http://localhost:3087/auth/google/callback"],
  ["http://localhost:3086", "http://localhost:3087/auth/google/callback"],
  ["http://127.0.0.1:3086/", "http://localhost:3087/auth/google/callback"],
  ["http://[::1]:3086", "http://localhost:3087/auth/google/callback"],
  ["not a url", "http://localhost:3087/auth/google/callback"],
  ["ftp://kernl.example.org", "http://localhost:3087/auth/google/callback"],
  ["https://kernl.example.org", "https://kernl.example.org/auth/google/callback"],
  ["https://kernl.example.org/", "https://kernl.example.org/auth/google/callback"],
  ["  https://kernl.example.org:8443/kernl/  ", "https://kernl.example.org:8443/kernl/auth/google/callback"],
];

describe("google oauth: redirect URI", () => {
  for (const [base, want] of CASES) {
    it(`public URL ${JSON.stringify(base)} → ${want}`, () => {
      expect(dashboardRedirectUri(3087, base)).toBe(want);
      // The project link rides on the same registered redirect: both must always agree.
      expect(googleRedirectUri(3087, base)).toBe(want);
    });
  }
  it("publicDashboardBase only keeps a remote http(s) URL", () => {
    expect(publicDashboardBase("https://kernl.example.org/")).toBe("https://kernl.example.org");
    expect(publicDashboardBase("http://localhost:3086")).toBe("");
  });
  it("reads DASHBOARD_PUBLIC_URL when no base is passed", () => {
    const prev = process.env.DASHBOARD_PUBLIC_URL;
    try {
      process.env.DASHBOARD_PUBLIC_URL = "https://kernl.example.org";
      expect(dashboardRedirectUri(3087)).toBe("https://kernl.example.org/auth/google/callback");
      expect(googleRedirectUri(3087)).toBe("https://kernl.example.org/auth/google/callback");
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_PUBLIC_URL; else process.env.DASHBOARD_PUBLIC_URL = prev;
    }
  });
});

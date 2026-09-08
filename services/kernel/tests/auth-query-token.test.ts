import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { isAuthenticated } from "../src/core/auth.js";

const TOKEN = "secret-token-123";

function req(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}

describe("isAuthenticated", () => {
  it("accepts a valid Bearer header", () => {
    expect(isAuthenticated(req("/api/torrents/index", { authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true);
  });

  it("rejects a wrong Bearer header", () => {
    expect(isAuthenticated(req("/api/torrents/index", { authorization: "Bearer nope" }), TOKEN)).toBe(false);
  });

  it("accepts ?auth= on SSE requests", () => {
    expect(isAuthenticated(req(`/api/torrents/subs/progress?auth=${TOKEN}`, { accept: "text/event-stream" }), TOKEN)).toBe(true);
  });

  it("rejects ?auth= on a normal JSON API request (no header, no SSE)", () => {
    expect(isAuthenticated(req(`/api/torrents/index?auth=${TOKEN}`), TOKEN)).toBe(false);
  });

  // ── Media-streaming routes loaded by <video>/ffmpeg (can't set headers) ──
  it("accepts ?auth= on the transcode route", () => {
    expect(isAuthenticated(req(`/api/torrents/transcode?url=x&auth=${TOKEN}`, { accept: "*/*" }), TOKEN)).toBe(true);
  });

  it("accepts ?auth= on a file/stream route", () => {
    expect(isAuthenticated(req(`/api/torrents/abc-123/file/0/stream?auth=${TOKEN}`), TOKEN)).toBe(true);
  });

  it("accepts ?auth= on the webseed-proxy route", () => {
    expect(isAuthenticated(req(`/api/torrents/webseed-proxy?url=x&auth=${TOKEN}`), TOKEN)).toBe(true);
  });

  // A rendered frame is shown with <img src>, which cannot set a header.
  it("accepts ?auth= on a rendered Blender frame", () => {
    expect(isAuthenticated(req(`/api/blender/jobs/abc-123/frame/frame.png?auth=${TOKEN}`), TOKEN)).toBe(true);
  });

  it("still refuses ?auth= on the job listing beside it", () => {
    // Widening the allowlist to the whole extension would put the token in a
    // URL for ordinary JSON, which is what keeping it narrow avoids.
    expect(isAuthenticated(req(`/api/blender/jobs/abc-123?auth=${TOKEN}`), TOKEN)).toBe(false);
    expect(isAuthenticated(req(`/api/blender/settings?auth=${TOKEN}`), TOKEN)).toBe(false);
  });

  it("does not let a crafted path escape the frame route", () => {
    expect(isAuthenticated(req(`/api/blender/jobs/a/frame/x/../../settings?auth=${TOKEN}`), TOKEN)).toBe(false);
  });

  it("still rejects a wrong token on a media route", () => {
    expect(isAuthenticated(req("/api/torrents/transcode?url=x&auth=wrong"), TOKEN)).toBe(false);
  });

  // ── Cinema's media routes — the free module's equivalents ──
  //
  // These were absent from the allowlist while the paid torrents ones were
  // present, so every playback in cinema answered 401: a <video src> cannot
  // send an Authorization header, and the frontend's `&auth=` was rejected.
  // The player showed 0:00 with no error, because the request never reached a
  // handler that could produce one.
  it("accepts ?auth= on the cinema transcode route", () => {
    expect(isAuthenticated(req(`/api/cinema/media/transcode?url=x&auth=${TOKEN}`, { accept: "*/*" }), TOKEN)).toBe(true);
  });

  it("accepts ?auth= on the cinema webseed-proxy route", () => {
    expect(isAuthenticated(req(`/api/cinema/media/webseed-proxy?url=x&auth=${TOKEN}`), TOKEN)).toBe(true);
  });

  it("still rejects a wrong token on a cinema media route", () => {
    expect(isAuthenticated(req("/api/cinema/media/transcode?url=x&auth=wrong"), TOKEN)).toBe(false);
  });

  it("does not open the rest of the cinema API to query tokens", () => {
    // The fallback is for clients that cannot set a header, not a general
    // way to put the token in a URL — and so in logs and history.
    expect(isAuthenticated(req(`/api/cinema/search?q=x&auth=${TOKEN}`), TOKEN)).toBe(false);
    expect(isAuthenticated(req(`/api/cinema/media/probe?url=x&auth=${TOKEN}`), TOKEN)).toBe(false);
  });
});

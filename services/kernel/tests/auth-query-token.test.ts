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

  it("still rejects a wrong token on a media route", () => {
    expect(isAuthenticated(req("/api/torrents/transcode?url=x&auth=wrong"), TOKEN)).toBe(false);
  });
});

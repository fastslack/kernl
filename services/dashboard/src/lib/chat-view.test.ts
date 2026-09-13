/**
 * What the chat transcript shows: unpacking a stored message, resolving an
 * image, labelling a provider, and where the day separators fall.
 *
 * The auth predicates are only pinned on their negative path here — whether a
 * given text IS a Claude Code auth error is `claude-code-auth.ts`'s rule, and
 * it has its own tests. What matters at this layer is that malformed payloads
 * never throw.
 */

import { describe, it, expect } from "bun:test";
import {
  msgAuthError,
  streamAuthError,
  parseContentBlocks,
  parseStoredMessage,
  imageSrc,
  providerIcon,
  providerColor,
  fmtCtx,
  isDateBreak,
  formatDateBreak,
} from "./chat-view.js";

describe("auth error predicates", () => {
  it("are false for ordinary content", () => {
    expect(msgAuthError({ content: "hello" })).toBe(false);
    expect(streamAuthError([{ type: "text", text: "hello" }])).toBe(false);
  });

  it("survive malformed or missing payloads", () => {
    expect(msgAuthError(null)).toBe(false);
    expect(msgAuthError({})).toBe(false);
    expect(msgAuthError({ content_blocks: "{not json" })).toBe(false);
    expect(msgAuthError({ content_blocks: { nope: true } })).toBe(false);
    expect(streamAuthError([])).toBe(false);
    expect(streamAuthError(undefined as unknown as any[])).toBe(false);
  });

  it("ignores non-text blocks in the live bubble", () => {
    expect(streamAuthError([{ type: "tool_use", text: "whatever" }])).toBe(false);
  });
});

describe("parseContentBlocks", () => {
  it("returns the array when there is one", () => {
    expect(parseContentBlocks('[{"type":"text"}]')).toEqual([{ type: "text" }]);
  });

  it("is empty for nothing, junk, or a non-array", () => {
    expect(parseContentBlocks(undefined)).toEqual([]);
    expect(parseContentBlocks("{not json")).toEqual([]);
    expect(parseContentBlocks('{"a":1}')).toEqual([]);
  });
});

describe("parseStoredMessage", () => {
  it("treats plain prose as text", () => {
    expect(parseStoredMessage("just words")).toEqual({
      text: "just words", images: [], documents: [], local: false,
    });
  });

  it("unpacks an envelope with attachments", () => {
    const raw = JSON.stringify({
      text: "look", images: ["a.png"], documents: [{ filename: "f.pdf", path: "/p/f.pdf" }], _local: true,
    });
    expect(parseStoredMessage(raw)).toEqual({
      text: "look",
      images: ["a.png"],
      documents: [{ filename: "f.pdf", path: "/p/f.pdf" }],
      local: true,
    });
  });

  it("normalises a document given as a bare path", () => {
    const raw = JSON.stringify({ text: "x", documents: ["/p/f.pdf"] });
    expect(parseStoredMessage(raw).documents).toEqual([{ path: "/p/f.pdf" }]);
  });

  it("keeps the raw text when a brace-leading payload does not parse", () => {
    expect(parseStoredMessage("{not json").text).toBe("{not json");
  });

  it("defaults missing fields rather than dropping the message", () => {
    expect(parseStoredMessage('{"images":"nope"}')).toEqual({
      text: "", images: [], documents: [], local: false,
    });
  });
});

describe("imageSrc", () => {
  it("passes through local previews and absolute urls", () => {
    expect(imageSrc("data:image/png;base64,xx", false)).toBe("data:image/png;base64,xx");
    expect(imageSrc("https://x.dev/a.png", false)).toBe("https://x.dev/a.png");
    expect(imageSrc("anything", true)).toBe("anything");
  });

  it("routes a stored path through the images endpoint, encoded", () => {
    expect(imageSrc("chat/a b.png", false)).toBe("/api/chat/images?path=chat%2Fa%20b.png");
  });
});

describe("provider badges", () => {
  it("maps the known providers", () => {
    expect(providerIcon("anthropic")).toBe("A");
    expect(providerIcon("LMStudio")).toBe("L");
    expect(providerColor("openai")).toBe("#3DD68C");
    expect(providerColor("claude-code")).toBe("#D4A84B");
  });

  it("derives a letter for an unknown provider and falls back for none", () => {
    expect(providerIcon("grok")).toBe("G");
    expect(providerIcon(undefined)).toBe("M");
    expect(providerIcon("")).toBe("M");
    expect(providerColor("whoever")).toBe("var(--gold)");
    expect(providerColor(undefined)).toBe("var(--gold)");
  });
});

describe("fmtCtx", () => {
  it("is empty when there is no context to report", () => {
    expect(fmtCtx()).toBe("");
    expect(fmtCtx(0)).toBe("");
  });

  it("switches to thousands at 1000", () => {
    expect(fmtCtx(999)).toBe("999 ctx");
    expect(fmtCtx(128_000)).toBe("128k ctx");
  });
});

describe("day separators", () => {
  const at = (iso: string) => ({ created_at: iso });

  it("always breaks before the first message", () => {
    expect(isDateBreak([at("2026-09-12T10:00:00Z")], 0)).toBe(true);
  });

  it("breaks only when the calendar day changes", () => {
    const msgs = [at("2026-09-11T10:00:00Z"), at("2026-09-11T23:00:00Z"), at("2026-09-12T01:00:00Z")];
    expect(isDateBreak(msgs, 1)).toBe(false);
    expect(isDateBreak(msgs, 2)).toBe(true);
  });

  it("names today and yesterday, and dates anything older", () => {
    const now = new Date();
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    expect(formatDateBreak(now.toISOString())).toBe("Today");
    expect(formatDateBreak(yest.toISOString())).toBe("Yesterday");

    const old = new Date(now);
    old.setDate(old.getDate() - 30);
    const label = formatDateBreak(old.toISOString());
    expect(label).not.toBe("Today");
    expect(label).not.toBe("Yesterday");
    expect(label.length).toBeGreaterThan(0);
  });
});

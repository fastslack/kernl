/**
 * Shared channel helpers. chunkText exists because Discord (2000) and
 * Telegram (4096) reject a longer message outright, and an agent's reply was
 * lost whole when it ran over.
 */

import { describe, it, expect } from "bun:test";
import { chunkText, csvList, formatNotification, mimeToAttachmentType } from "../src/sdk/channels.js";

describe("chunkText", () => {
  it("leaves a short text alone", () => {
    expect(chunkText("hello", 2000)).toEqual(["hello"]);
  });

  it("keeps every piece within the limit and loses nothing but the breaks", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(i % 40)}`).join("\n");
    const pieces = chunkText(text, 2000);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(2000);
    expect(pieces.join("\n").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("prefers a paragraph break over a line break", () => {
    const text = `${"a".repeat(1200)}\n\n${"b".repeat(500)}\n${"c".repeat(600)}`;
    expect(chunkText(text, 2000)[0]).toBe("a".repeat(1200));
  });

  it("cuts a word only when it alone is longer than the limit", () => {
    const pieces = chunkText("y".repeat(4500), 2000);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(2000);
    expect(pieces.join("")).toBe("y".repeat(4500));
  });

  it("closes a code fence at the cut and reopens it in the next piece", () => {
    const code = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const pieces = chunkText(`Here:\n\`\`\`ts\n${code}\n\`\`\`\nDone.`, 2000);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(2000);
      expect((p.split("```").length - 1) % 2).toBe(0);
    }
  });
});

describe("helpers", () => {
  it("formats a notification in the platform's style", () => {
    expect(formatNotification({ title: "T", body: "B", priority: "high" }, { bold: "*", alert: ":rotating_light: " }))
      .toBe(":rotating_light: *T*\nB");
    expect(formatNotification({ title: "T" }, { bold: "**", alert: "🚨 " })).toBe("**T**");
  });

  it("reads a comma list", () => {
    expect(csvList(" a, b,,c ")).toEqual(["a", "b", "c"]);
    expect(csvList(undefined)).toEqual([]);
  });

  it("maps a MIME type to an attachment kind", () => {
    expect(mimeToAttachmentType("image/png")).toBe("image");
    expect(mimeToAttachmentType("application/pdf")).toBe("document");
  });
});

import { describe, it, expect } from "bun:test";
import { extractJsonArray } from "../assets/extensions/people/comms/_module/email-triage-service.js";

describe("extractJsonArray", () => {
  it("reads a bare array", () => {
    expect(extractJsonArray('[{"idx":0,"urgency":"low"}]')).toEqual([{ idx: 0, urgency: "low" }]);
  });

  it("skips reasoning prose that mentions brackets and takes the final answer", () => {
    const raw = [
      "We need to output JSON array with [idx] for each email. Example: [{idx: 0, ...}] is not valid JSON.",
      "Now classify.",
      '[{"idx":0,"urgency":"high","attention_needed":true,"summary":"Invoice due [today]"},',
      ' {"idx":1,"urgency":"low","attention_needed":false,"summary":"Newsletter"}]',
    ].join("\n");
    const out = extractJsonArray(raw) as Array<{ idx: number; summary: string }>;
    expect(out.map((r) => r.idx)).toEqual([0, 1]);
    expect(out[0].summary).toBe("Invoice due [today]");
  });

  it("prefers the last valid array when the model drafts one first", () => {
    const raw = 'Draft: [{"idx":0,"urgency":"low"}]\nFinal:\n[{"idx":0,"urgency":"high"}]';
    expect(extractJsonArray(raw)).toEqual([{ idx: 0, urgency: "high" }]);
  });

  it("handles code fences and an empty answer", () => {
    expect(extractJsonArray('```json\n[{"idx":2}]\n```')).toEqual([{ idx: 2 }]);
    expect(extractJsonArray("Nothing needs attention: []")).toEqual([]);
  });

  it("returns null when the answer was cut off before any complete array", () => {
    expect(extractJsonArray('We need to classify. [{"idx":0,"urgency":"hi')).toBeNull();
    expect(extractJsonArray("We need to output JSON array with classification for each email idx.")).toBeNull();
  });
});

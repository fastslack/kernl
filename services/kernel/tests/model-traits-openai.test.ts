/**
 * `classifyModel` is what keeps non-chat models out of every model picker.
 * Its OpenAI rule was written against the 2024 catalogue and anchored on
 * `gpt-4o-*`, so ids OpenAI shipped since — `gpt-realtime`, `gpt-transcribe`,
 * `gpt-live-transcribe` — walked straight through as chat models. All 11 of
 * them were being offered in the chat picker of a live install; none of them
 * serves /v1/chat/completions, so picking one is a guaranteed 400.
 */
import { describe, it, expect } from "bun:test";
import { classifyModel } from "../src/core/llm/model-traits.js";

describe("classifyModel — OpenAI non-chat endpoints", () => {
  const notChat = [
    "gpt-image-1",
    "gpt-image-2",
    "chatgpt-image-1",
    "gpt-realtime",
    "gpt-realtime-2.1",
    "gpt-realtime-mini-2025-12-15",
    "gpt-realtime-translate",
    "gpt-transcribe",
    "gpt-live-transcribe",
    "gpt-audio",
    "gpt-4o-audio-preview",
    "gpt-4o-transcribe",
    "gpt-4o-mini-tts",
    "tts-1",
    "whisper-1",
    "text-embedding-3-large",
    "omni-moderation-latest",
  ];
  for (const id of notChat) {
    it(`keeps ${id} out of the chat list`, () => {
      expect(classifyModel("openai", id).chat).toBe(false);
    });
  }

  it("labels why each one was dropped", () => {
    expect(classifyModel("openai", "gpt-image-2").image).toBe(true);
    expect(classifyModel("openai", "gpt-transcribe").audio).toBe(true);
    expect(classifyModel("openai", "gpt-realtime-2").audio).toBe(true);
  });

  // The other half of the bargain: broadening the rule must not eat the
  // chat catalogue. Every one of these is a real id from a live account.
  const chat = [
    "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    "gpt-5", "gpt-5-codex", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro",
    "gpt-5.1", "gpt-5.1-codex-max", "gpt-5.2-pro", "gpt-5.4-nano",
    "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
    "chatgpt-4o-latest", "o1-pro", "o3-mini",
  ];
  for (const id of chat) {
    it(`keeps ${id} in the chat list`, () => {
      expect(classifyModel("openai", id).chat).toBe(true);
    });
  }
});

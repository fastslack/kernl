/**
 * `/api/llm-providers/:slug/models` hides everything that cannot answer a chat.
 * That is right — an agent pinned to `gpt-image-2` would 400 on every run —
 * but a picker that answers "no model matches 'image'" is hiding the reason
 * along with the models. The route reports the hidden ones by name so the UI
 * can say what they are instead of pretending they don't exist.
 */
import { describe, it, expect } from "bun:test";
import { classifyModel } from "../src/core/llm/model-traits.js";

/** The classification the route runs, mirrored so the shape is pinned here. */
function partition(slug: string, ids: string[]) {
  const classified = ids.map((id) => ({ id, traits: classifyModel(slug, id) }));
  return {
    chat: classified.filter((m) => m.traits.chat).map((m) => m.id),
    nonChat: classified
      .filter((m) => !m.traits.chat)
      .map((m) => ({
        id: m.id,
        kind: m.traits.image ? "image"
          : m.traits.audio ? "audio"
          : m.traits.embedding ? "embedding"
          : m.traits.reranker ? "reranker"
          : m.traits.safety ? "safety"
          : "other",
      })),
  };
}

describe("non-chat models are reported, not just counted", () => {
  const { chat, nonChat } = partition("openai", [
    "gpt-5.6-luna", "gpt-4o-mini",
    "gpt-image-1", "gpt-image-2", "chatgpt-image-1",
    "gpt-transcribe", "gpt-realtime-2",
    "text-embedding-3-large", "omni-moderation-latest",
  ]);

  it("keeps the chat models in the list", () => {
    expect(chat).toEqual(["gpt-5.6-luna", "gpt-4o-mini"]);
  });

  it("names every image model it hid, and says it is an image model", () => {
    const images = nonChat.filter((m) => m.kind === "image").map((m) => m.id);
    expect(images).toEqual(["gpt-image-1", "gpt-image-2", "chatgpt-image-1"]);
  });

  it("labels the audio and realtime endpoints as audio", () => {
    const audio = nonChat.filter((m) => m.kind === "audio").map((m) => m.id);
    expect(audio).toContain("gpt-transcribe");
    expect(audio).toContain("gpt-realtime-2");
  });

  it("labels embeddings and moderation", () => {
    expect(nonChat.find((m) => m.id === "text-embedding-3-large")?.kind).toBe("embedding");
    expect(nonChat.find((m) => m.id === "omni-moderation-latest")?.kind).toBe("safety");
  });

  it("every hidden model carries a reason — none fall through unlabelled", () => {
    expect(nonChat.every((m) => m.kind !== "other")).toBe(true);
  });
});

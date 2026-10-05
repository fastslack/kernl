import { describe, it, expect } from "bun:test";
import { groupEpisodes, countBySource, modelLine, modelName } from "./chat-groups.js";

const eps = [
  { id: "a", title: "status of research office", source: "office3d", source_label: "Chief", llm_provider: "claude_code", llm_model: "" },
  { id: "b", title: "hola que modelo eres?", source: "dashboard", llm_provider: "openai", llm_model: "gpt-4o-mini" },
  { id: "c", title: "", source: "office3d", source_label: "Chief", llm_provider: "claude-code", llm_model: "claude-opus-5-5" },
  { id: "d", title: "telegram 1", source: "platform", source_label: "telegram", llm_provider: "claude-code", llm_model: "" },
  { id: "e", title: "legacy row" },
];

describe("chat-groups", () => {
  it("groups in sidebar order and keeps recency inside a group", () => {
    const groups = groupEpisodes(eps);
    expect(groups.map((g) => g.source)).toEqual(["office3d", "dashboard", "platform"]);
    expect(groups[0].episodes.map((e) => e.id)).toEqual(["a", "c"]);
    expect(groups[1].episodes.map((e) => e.id)).toEqual(["b", "e"]);
  });

  it("filters by source and by query over title, label and model", () => {
    expect(groupEpisodes(eps, { source: "platform" }).flatMap((g) => g.episodes.map((e) => e.id))).toEqual(["d"]);
    expect(groupEpisodes(eps, { query: "opus" }).flatMap((g) => g.episodes.map((e) => e.id))).toEqual(["c"]);
    expect(groupEpisodes(eps, { query: "chief" }).flatMap((g) => g.episodes.map((e) => e.id))).toEqual(["a", "c"]);
  });

  it("counts per source for the chips", () => {
    expect(countBySource(eps)).toEqual([
      { source: "office3d", count: 2 },
      { source: "dashboard", count: 2 },
      { source: "platform", count: 1 },
    ]);
  });

  it("names models and providers readably", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(modelName("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(modelLine(eps[0])).toBe("Claude Code");
    expect(modelLine(eps[2])).toBe("Opus 5.5 · Claude Code");
    expect(modelLine({ id: "x" })).toBe("Default model");
  });
});

import { describe, it, expect } from "bun:test";
import { moveLink, connectionRows, type CatalogProvider } from "./llm-connect.js";

const p = (slug: string, connected: boolean) => ({ slug, connected }) as CatalogProvider;

describe("settings helpers", () => {
  it("moves a chain link and never mutates", () => {
    const chain = [{ provider: "a", model: "" }, { provider: "b", model: "" }, { provider: "c", model: "" }];
    expect(moveLink(chain, 2, -1).map((l) => l.provider)).toEqual(["a", "c", "b"]);
    expect(moveLink(chain, 0, -1).map((l) => l.provider)).toEqual(["a", "b", "c"]);
    expect(chain.map((l) => l.provider)).toEqual(["a", "b", "c"]);
  });

  it("lists connected providers in chain order, then the rest", () => {
    const rows = connectionRows(
      [p("nvidia", true), p("gemini", false), p("groq", true), p("ollama", true)],
      [{ provider: "groq", model: "" }, { provider: "nvidia", model: "" }],
    );
    expect(rows.map((r) => r.slug)).toEqual(["groq", "nvidia", "ollama"]);
  });
});

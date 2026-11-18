/**
 * Backup models within one provider (Settings → AI): another NVIDIA model
 * behind the first, the way Claude Code takes more than one account.
 */
import { describe, it, expect } from "bun:test";
import { addModelLink, extraModelLinks, removeLinkAt, withBackupModels, type CatalogProvider, type ChainLink } from "./llm-connect.js";
import type { ConnectionLine } from "./claude-accounts.js";

const chain: ChainLink[] = [
  { provider: "nvidia", model: "" },
  { provider: "groq", model: "" },
];

describe("addModelLink", () => {
  it("puts the model right after the provider's last link", () => {
    const one = addModelLink(chain, "nvidia", "moonshotai/kimi-k3.1-pro", "nvidia/nemotron");
    expect(one).toEqual([
      { provider: "nvidia", model: "" },
      { provider: "nvidia", model: "moonshotai/kimi-k3.1-pro" },
      { provider: "groq", model: "" },
    ]);
    const two = addModelLink(one, "nvidia", "deepseek-ai/deepseek-v4-flash");
    expect(two.map((l) => l.model)).toEqual(["", "moonshotai/kimi-k3.1-pro", "deepseek-ai/deepseek-v4-flash", ""]);
  });

  it("skips a model the provider already uses, its main row's default included", () => {
    expect(addModelLink(chain, "nvidia", "nvidia/nemotron", "nvidia/nemotron")).toEqual(chain);
    const one = addModelLink(chain, "nvidia", "x");
    expect(addModelLink(one, "nvidia", " x ")).toEqual(one);
    expect(addModelLink(chain, "nvidia", "  ")).toEqual(chain);
  });

  it("appends a provider not in the chain yet", () => {
    expect(addModelLink(chain, "gemini", "g")).toEqual([...chain, { provider: "gemini", model: "g" }]);
  });
});

describe("extraModelLinks / removeLinkAt", () => {
  const full: ChainLink[] = [
    { provider: "nvidia", model: "" }, { provider: "groq", model: "" }, { provider: "nvidia", model: "b" },
  ];
  it("lists every link of the provider after its first, with its place", () => {
    expect(extraModelLinks(full, "nvidia")).toEqual([{ model: "b", index: 2 }]);
    expect(extraModelLinks(full, "groq")).toEqual([]);
  });
  it("removes exactly that link", () => {
    expect(removeLinkAt(full, 2)).toEqual(full.slice(0, 2));
    expect(removeLinkAt(full, 9)).toEqual(full);
  });
});

describe("withBackupModels", () => {
  const prov = (slug: string) => ({ slug, name: slug.toUpperCase() }) as CatalogProvider;
  const line = (slug: string, key = slug, extra = false): ConnectionLine =>
    ({ key, provider: prov(slug), account: null, index: -1, extra, multi: false });

  it("puts each backup below its provider's last row, numbered", () => {
    const lines = [line("claude-code"), line("claude-code", "claude-code:2", true), line("nvidia")];
    const out = withBackupModels(lines, [
      { provider: "nvidia", model: "" }, { provider: "nvidia", model: "a" },
      { provider: "claude-code", model: "" }, { provider: "claude-code", model: "opus" }, { provider: "nvidia", model: "b" },
    ]);
    expect(out.map((l) => l.key)).toEqual([
      "claude-code", "claude-code:2", "claude-code:model:3", "nvidia", "nvidia:model:1", "nvidia:model:4",
    ]);
    expect(out[4].backup).toEqual({ model: "a", index: 1, n: 1 });
    expect(out[5].backup).toEqual({ model: "b", index: 4, n: 2 });
  });
});

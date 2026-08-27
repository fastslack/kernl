/**
 * Skill scoring: keyword overlap weighted by IDF, no LLM.
 *
 * The reason it is deterministic is documented in skill-suggester.ts:6 — LLM
 * matching against a large inventory burned ~500k tokens and fabricated
 * skills that did not exist. This module is the same maths, extracted so the
 * cron and the per-agent endpoint share one implementation and so it can be
 * proven without a database.
 */

import { describe, it, expect } from "bun:test";
import {
  tokenize,
  computeIdf,
  rankSkillsForAgent,
  skillRowText,
  agentRowText,
} from "../src/modules/agents/skill-scoring.js";

describe("tokenize", () => {
  it("drops stopwords, short tokens and punctuation", () => {
    expect(tokenize("Use the agent to run SEO audits!")).toEqual(["seo", "audits"]);
  });

  it("keeps hyphens and underscores, which carry slug shape", () => {
    expect(tokenize("web-design guidelines")).toEqual(["web-design", "guidelines"]);
  });

  it("keeps accented Spanish words intact instead of shredding them", () => {
    // Regression: the old ASCII-only class treated the accent itself as a
    // separator, so "diseño" tokenized to "dise" + "o" and the length
    // filter then dropped both — every accented content word vanished.
    // This office's agents are prompted in Spanish, so this was not rare.
    expect(tokenize("diseño configuración gestión análisis código")).toEqual([
      "diseño",
      "configuración",
      "gestión",
      "análisis",
      "código",
    ]);
  });

  it("does not split a single accented word into fragments", () => {
    expect(tokenize("diseño")).toEqual(["diseño"]);
    expect(tokenize("El diseño del sistema")).toContain("diseño");
    expect(tokenize("El diseño del sistema")).not.toContain("dise");
  });
});

describe("computeIdf", () => {
  it("weights a rare token above a common one", () => {
    const tokens = new Map([
      ["a", new Set(["deploy", "seo"])],
      ["b", new Set(["deploy"])],
      ["c", new Set(["deploy"])],
    ]);
    const idf = computeIdf(tokens, 3);
    expect(idf.get("seo")!).toBeGreaterThan(idf.get("deploy")!);
  });

  it("never returns a zero or negative weight", () => {
    const tokens = new Map([["a", new Set(["x"])], ["b", new Set(["x"])]]);
    for (const w of computeIdf(tokens, 2).values()) expect(w).toBeGreaterThan(0);
  });
});

describe("rankSkillsForAgent", () => {
  const skills = [
    { slug: "seo-audit", text: "seo-audit crawl sitemap meta ranking" },
    { slug: "web-perf", text: "web-perf latency bundle lighthouse ranking" },
    { slug: "cooking", text: "cooking recipes kitchen" },
  ];

  it("ranks the skill whose vocabulary the agent shares", () => {
    const out = rankSkillsForAgent(
      { text: "Audits the sitemap and meta tags for ranking", attached: new Set() },
      skills,
    );
    expect(out[0].slug).toBe("seo-audit");
  });

  it("excludes skills already attached", () => {
    const out = rankSkillsForAgent(
      { text: "Audits the sitemap and meta tags", attached: new Set(["seo-audit"]) },
      skills,
    );
    expect(out.map((m) => m.slug)).not.toContain("seo-audit");
  });

  it("gives a strong bonus when the slug appears verbatim in the prompt", () => {
    const withSlug = rankSkillsForAgent(
      { text: "Always run web-perf before a deploy", attached: new Set() },
      skills,
    );
    expect(withSlug[0].slug).toBe("web-perf");
    expect(withSlug[0].matches[0]).toBe("slug:web-perf");
  });

  it("returns nothing when no vocabulary is shared", () => {
    const out = rankSkillsForAgent(
      { text: "Handles payroll and invoices", attached: new Set() },
      [{ slug: "cooking", text: "cooking recipes kitchen" }],
    );
    expect(out).toEqual([]);
  });

  it("honours minScore and topN", () => {
    const out = rankSkillsForAgent(
      { text: "sitemap meta ranking latency bundle", attached: new Set() },
      skills,
      { minScore: 0.1, topN: 1 },
    );
    expect(out).toHaveLength(1);
  });
});

describe("row text builders", () => {
  it("folds slug, name, description and long_description into the skill blob", () => {
    const text = skillRowText({
      slug: "seo-audit",
      name: "SEO Audit",
      manifest_json: JSON.stringify({ description: "crawl", long_description: "sitemap" }),
    });
    expect(text).toContain("seo-audit");
    expect(text).toContain("crawl");
    expect(text).toContain("sitemap");
  });

  it("survives a manifest that is not valid JSON", () => {
    const text = skillRowText({ slug: "x", name: "X", manifest_json: "{not json" });
    expect(text).toContain("x");
  });

  it("caps the system prompt so a 10k operator prompt cannot drown the signal", () => {
    const text = agentRowText({
      name: "A",
      description: "d",
      system_prompt: "z".repeat(5000),
      flow_name: null,
    });
    expect(text.length).toBeLessThan(2200);
  });
});

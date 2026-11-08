/**
 * Skill vectors: meaning-based scores for the skill recommender, cached in
 * SQLite and re-made only when a skill's text or the embedding model changes.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { SkillVectorIndex } from "../src/modules/agents/skill-vectors.js";
import { rankSkillsForAgent } from "../src/modules/agents/skill-scoring.js";
import type { EmbeddingsClient } from "../src/core/embeddings/client.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

/** Embeds by topic keyword, in either language, so meaning crosses languages. */
function fakeClient(model = "fake-1"): EmbeddingsClient & { calls: number; texts: number } {
  const topics: Array<RegExp> = [/seo|citad|llm|asistentes de ia/i, /git|commit|branch/i, /legal|abogad|escrito/i];
  const client = {
    provider: "openai" as const,
    model,
    dim: topics.length,
    calls: 0,
    texts: 0,
    available: async () => true,
    embed: async (texts: string[]) => {
      client.calls += 1;
      client.texts += texts.length;
      return texts.map((t) => topics.map((re) => (re.test(t) ? 1 : 0.01)));
    },
  };
  return client;
}

const skills = [
  { slug: "ai-seo", text: "ai-seo Get cited by LLMs and AI answers" },
  { slug: "git-workflow", text: "git-workflow commit and branch hygiene" },
  { slug: "escritos-civil", text: "escritos-civil escritos judiciales para abogados" },
];

describe("SkillVectorIndex", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db as unknown as SqliteDb, "agents", agentsMigrations);
  });

  it("ranks by meaning across languages", async () => {
    const client = fakeClient();
    const idx = new SkillVectorIndex(db as unknown as SqliteDb, () => client);
    const out = await idx.score(
      { id: "a1", text: "Consigue que los asistentes de IA nombren el producto" },
      skills,
    );
    expect(out.state).toBe("on");
    const best = [...out.scores].sort((a, b) => b[1] - a[1])[0][0];
    expect(best).toBe("ai-seo");
  });

  it("embeds each skill once and again only when its text changes", async () => {
    const client = fakeClient();
    const idx = new SkillVectorIndex(db as unknown as SqliteDb, () => client);
    const agent = { id: "a1", text: "git commits" };
    await idx.score(agent, skills);
    const after1 = client.texts;
    await idx.score(agent, skills);
    expect(client.texts).toBe(after1);
    await idx.score(agent, [{ ...skills[0], text: skills[0].text + " v2" }, ...skills.slice(1)]);
    expect(client.texts).toBe(after1 + 1);
  });

  it("re-embeds under a new model instead of mixing vector spaces", async () => {
    let client = fakeClient("m1");
    const idx = new SkillVectorIndex(db as unknown as SqliteDb, () => client);
    await idx.score({ id: "a1", text: "git" }, skills);
    client = fakeClient("m2");
    await idx.score({ id: "a1", text: "git" }, skills);
    expect(client.texts).toBe(skills.length + 1);
  });

  it("is off without an embeddings client", async () => {
    const idx = new SkillVectorIndex(db as unknown as SqliteDb, () => null);
    expect((await idx.score({ id: "a1", text: "x" }, skills)).state).toBe("off");
  });

  it("answers warming when the catalogue cannot be embedded in time", async () => {
    const slow = fakeClient();
    const embed = slow.embed;
    slow.embed = async (t: string[]) => {
      await new Promise((r) => setTimeout(r, 200));
      return embed(t);
    };
    const idx = new SkillVectorIndex(db as unknown as SqliteDb, () => slow);
    const out = await idx.score({ id: "a1", text: "x" }, skills, { waitMs: 10 });
    expect(out.state).toBe("warming");
  });

  it("stays off when the provider fails, never throws", async () => {
    const broken = fakeClient();
    broken.embed = async () => {
      throw new Error("down");
    };
    const idx = new SkillVectorIndex(db as unknown as SqliteDb, () => broken);
    const out = await idx.score({ id: "a1", text: "x" }, skills);
    expect(out.state).not.toBe("on");
  });
});

describe("rankSkillsForAgent with semantic scores", () => {
  it("lets meaning outrank keyword overlap from another language", () => {
    const out = rankSkillsForAgent(
      { text: "Escritos y reclamos: que los asistentes de IA citen el producto", attached: new Set() },
      skills,
      { semantic: new Map([["ai-seo", 0.8], ["git-workflow", 0.1], ["escritos-civil", 0.3]]) },
    );
    expect(out[0].slug).toBe("ai-seo");
  });
});

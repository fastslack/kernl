import { describe, it, expect } from "bun:test";
import { draftOfficeDefinition, DraftError, MAX_DRAFT_DESCRIPTION } from "../src/modules/agents/office-draft.js";
import type { LlmChatOptions } from "../src/core/llm/client.js";

const reply = (value: unknown) => {
  const calls: LlmChatOptions[] = [];
  const chatJson = async (opts: LlmChatOptions) => { calls.push(opts); return value; };
  return { chatJson, calls };
};

const goodDraft = {
  name: "Code Review",
  description: "Reviews every PR",
  kind: "devops",
  agents: [
    { name: "Lead", role: "manager", description: "Hands out PRs", prompt: "You hand out PRs.", chainTo: ["Reviewer", "QA"] },
    { name: "Reviewer", role: "worker", description: "Reads the diff", prompt: "You review diffs." },
    { name: "QA", role: "worker", description: "Runs tests", prompt: "You run the tests." },
  ],
  cron: { agent: "Lead", every: "1h" },
};

describe("draftOfficeDefinition", () => {
  it("returns a validated definition and keeps chainTo/cron.agent as agent NAMEs", async () => {
    const { chatJson, calls } = reply(goodDraft);
    const def = await draftOfficeDefinition({ description: "Un equipo que revise PRs", language: "es" }, chatJson);
    expect(def.name).toBe("Code Review");
    expect(def.kind).toBe("devops");
    const lead = def.agents.find((a) => a.name === "Lead")!;
    // Names, not slugs: the wizard sends names back, and the create endpoint
    // (officeDefinitionFromJson) resolves them to slugs from the FINAL office
    // name at POST time — so a slug baked in here could go stale if the
    // operator renames the office before founding it.
    expect(lead.chainTo).toEqual(["Reviewer", "QA"]);
    expect(def.cron?.agent).toBe("Lead");
    expect((lead as unknown as { slug?: string }).slug).toBeUndefined();
    expect(calls[0].json).toBe(true);
    expect(calls[0].caller).toBe("offices:draft");
    expect(calls[0].system).toContain("Spanish");
  });

  it("whitelists the draft output: drops repo/variables/executor/tools/slug and other unlisted fields", async () => {
    const { chatJson } = reply({
      ...goodDraft,
      repo: "~/some/repo",
      repoIsolation: "sandbox",
      modelChain: [{ provider: "grok", model: "x" }],
      discipline: "custom",
      previewUrl: "http://x",
      defaults: { tools: ["kernel_agents_run"] },
      agents: goodDraft.agents.map((a) => ({
        ...a,
        slug: `sneaky-slug-${a.name}`,
        variables: { __sandbox__: false },
        executor: "claude_code",
        tools: ["kernel_agents_run"],
        deniedTools: ["kernel_shell_run"],
        plugins: ["x/y"],
        goal: "do it",
        maxIterations: 99,
        timeoutMs: 123,
        showOnDashboard: false,
      })),
    });
    const def = await draftOfficeDefinition({ description: "algo", language: "en" }, chatJson);

    const wide = def as unknown as Record<string, unknown>;
    expect(wide.repo).toBeUndefined();
    expect(wide.repoIsolation).toBeUndefined();
    expect(wide.modelChain).toBeUndefined();
    expect(wide.discipline).toBeUndefined();
    expect(wide.previewUrl).toBeUndefined();
    expect(wide.defaults).toBeUndefined();

    for (const a of def.agents) {
      const wideAgent = a as unknown as Record<string, unknown>;
      expect(wideAgent.slug).toBeUndefined();
      expect(wideAgent.variables).toBeUndefined();
      expect(wideAgent.executor).toBeUndefined();
      expect(wideAgent.tools).toBeUndefined();
      expect(wideAgent.deniedTools).toBeUndefined();
      expect(wideAgent.plugins).toBeUndefined();
      expect(wideAgent.goal).toBeUndefined();
      expect(wideAgent.maxIterations).toBeUndefined();
      expect(wideAgent.timeoutMs).toBeUndefined();
      expect(wideAgent.showOnDashboard).toBeUndefined();
      expect(typeof wideAgent.name).toBe("string");
      expect(typeof wideAgent.prompt).toBe("string");
    }
  });

  it("rejects an empty or too long description as input errors, without calling the model", async () => {
    const { chatJson, calls } = reply(goodDraft);
    await expect(draftOfficeDefinition({ description: "   ", language: "en" }, chatJson)).rejects.toMatchObject({ kind: "input" });
    await expect(
      draftOfficeDefinition({ description: "x".repeat(MAX_DRAFT_DESCRIPTION + 1), language: "en" }, chatJson),
    ).rejects.toMatchObject({ kind: "input" });
    expect(calls.length).toBe(0);
  });

  it("maps a definition that does not validate to a draft error with the reason", async () => {
    const { chatJson } = reply({ name: "No agents", agents: [] });
    const err = await draftOfficeDefinition({ description: "algo", language: "es" }, chatJson).catch((e) => e);
    expect(err).toBeInstanceOf(DraftError);
    expect(err.kind).toBe("draft");
    expect(err.detail).toMatch(/at least one agent/);
  });

  it("maps a model failure to a draft error", async () => {
    const chatJson = async () => { throw new Error("Unexpected token < in JSON"); };
    await expect(draftOfficeDefinition({ description: "algo", language: "es" }, chatJson)).rejects.toMatchObject({
      kind: "draft",
      detail: "Unexpected token < in JSON",
    });
  });

  it("refuses drafts with more agents than the gallery allows", async () => {
    const many = { name: "Crowd", agents: Array.from({ length: 6 }, (_, i) => ({ name: `A${i}`, prompt: "p" })) };
    const { chatJson } = reply(many);
    await expect(draftOfficeDefinition({ description: "algo", language: "en" }, chatJson)).rejects.toMatchObject({ kind: "draft" });
  });
});

describe("draftOfficeDefinition repair attempt", () => {
  /** Replies with each value in turn, one per call. */
  const replies = (...values: unknown[]) => {
    const calls: LlmChatOptions[] = [];
    const chatJson = async (opts: LlmChatOptions) => {
      calls.push(opts);
      const v = values[calls.length - 1];
      if (v instanceof Error) throw v;
      return v;
    };
    return { chatJson, calls };
  };

  it("retries once, telling the model what was rejected", async () => {
    const { chatJson, calls } = replies({ name: "No agents" }, goodDraft);
    const def = await draftOfficeDefinition({ description: "Un equipo", language: "es" }, chatJson);

    expect(def.name).toBe("Code Review");
    expect(calls).toHaveLength(2);
    // The repair turn has to carry the original ask AND the reason, or the
    // model is just being asked the same thing twice.
    expect(calls[1].user).toContain("Un equipo");
    expect(calls[1].user).toContain("Your previous reply was rejected");
    expect(calls[1].caller).toBe("offices:draft:repair");
  });

  it("does not retry when the first reply is already valid", async () => {
    const { chatJson, calls } = replies(goodDraft, goodDraft);
    await draftOfficeDefinition({ description: "Un equipo", language: "es" }, chatJson);
    expect(calls).toHaveLength(1);
  });

  it("stops after the repair and reports the LAST failure", async () => {
    const { chatJson, calls } = replies({ name: "bad" }, new Error("still wrong"));
    const err = await draftOfficeDefinition({ description: "Un equipo", language: "es" }, chatJson)
      .then(() => null, (e) => e as DraftError);

    expect(calls).toHaveLength(2);
    expect(err).toBeInstanceOf(DraftError);
    expect(err!.message).toBe("invalid_draft");
    expect(err!.detail).toBe("still wrong");
  });

  it("recovers when the model only fails to REACH the LLM the first time", async () => {
    const { chatJson, calls } = replies(new Error("connection reset"), goodDraft);
    const def = await draftOfficeDefinition({ description: "Un equipo", language: "es" }, chatJson);
    expect(def.name).toBe("Code Review");
    expect(calls).toHaveLength(2);
  });
});

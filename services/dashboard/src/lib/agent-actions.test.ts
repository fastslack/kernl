/**
 * The steps where an agent acts on another agent have to read, in the LIVE
 * log, as what they were: who got what, and whether it landed. These pin the
 * cases seen on the chief's runs.
 */
import { describe, it, expect } from "bun:test";
import { agentActionOf, isAgentActionTool, looseField, plainActionText } from "./agent-actions.js";

describe("agentActionOf", () => {
  it("reads a colleague message: recipient, subject, body, still on its way", () => {
    const a = agentActionOf(
      "mcp__kernel__kernel_agents_post_to_colleague",
      JSON.stringify({ to_agent_name: "Career Lead", subject: "Weekly pipeline", body: "Send me the three best leads." }),
    );
    expect(a).toEqual({
      kind: "message", icon: "📨", outcome: "pending", failure: "",
      target: "Career Lead", headline: "Weekly pipeline", body: "Send me the three best leads.",
    });
  });

  it("says why a message was not delivered, in the kernel's words", () => {
    const a = agentActionOf(
      "kernel_agents_post_to_colleague",
      JSON.stringify({ to_agent_name: "Career Lead", subject: "Hi", body: "x" }),
      { preview: 'Error: No agent named "Career Lead" found in your office. Use kernel_agents_directory or supply to_agent_id.', failed: true },
    );
    expect(a?.outcome).toBe("failed");
    expect(a?.failure).toBe('No agent named "Career Lead" found in your office. Use kernel_agents_directory or supply to_agent_id.');
  });

  it("reads a refusal recorded without an error flag as not delivered", () => {
    const a = agentActionOf(
      "mcp__kernel__kernel_agents_post_to_colleague",
      JSON.stringify({ to_agent_name: "Career Lead", subject: "Hi", body: "x" }),
      { preview: 'No agent named "Career Lead" found in your office. Use kernel_agents_directory or supply to_agent_id.', failed: false },
    );
    expect(a?.outcome).toBe("failed");
    expect(a?.failure).toContain('No agent named "Career Lead"');
  });

  it("names the recipient from the result when the call only had an id", () => {
    const a = agentActionOf(
      "kernel_agents_post_to_colleague",
      JSON.stringify({ to_agent_id: "534f4ced-1111-2222-3333-444455556666", subject: "s", body: "b" }),
      { preview: "Posted to **Analyst**'s inbox (id: m1).\nThey will see it at the top of their next run.", failed: false },
    );
    expect(a?.target).toBe("Analyst");
    expect(a?.outcome).toBe("ok");
  });

  it("prefers the roster over a short id", () => {
    const a = agentActionOf(
      "kernel_agents_run",
      JSON.stringify({ agent_id: "534f4ced-1111-2222-3333-444455556666", goal: "Refresh the board" }),
      undefined,
      (id) => (id.startsWith("534f4ced") ? "Analyst" : undefined),
    );
    expect(a?.target).toBe("Analyst");
    expect(a?.headline).toBe("Refresh the board");
  });

  it("keeps the subject and the start of the body of a preview cut at 800 chars", () => {
    const full = JSON.stringify({ to_agent_name: "Pitch", subject: "Rates", body: "a".repeat(2000) });
    const a = agentActionOf("kernel_agents_post_to_colleague", full.slice(0, 800));
    expect(a?.target).toBe("Pitch");
    expect(a?.headline).toBe("Rates");
    expect(a?.body.length).toBeGreaterThan(700);
  });

  it("lists what an edit changed, never the id", () => {
    const a = agentActionOf(
      "kernel_agents_update",
      JSON.stringify({ id: "534f4ced-1111-2222-3333-444455556666", max_iterations: 45 }),
      { preview: "Agent **Analyst** updated.", failed: false },
    );
    expect(a?.target).toBe("Analyst");
    expect(a?.headline).toBe("max_iterations → 45");
  });

  it("leaves ordinary tools alone", () => {
    expect(agentActionOf("Bash", JSON.stringify({ command: "ls" }))).toBeNull();
    expect(isAgentActionTool("mcp__kernel__kernel_agents_directory")).toBe(false);
    expect(isAgentActionTool("mcp__kernel__kernel_agents_post_to_colleague")).toBe(true);
  });
});

describe("looseField", () => {
  it("unescapes quotes and newlines", () => {
    expect(looseField(JSON.stringify({ body: 'say "hi"\nthen go' }), "body")).toBe('say "hi"\nthen go');
  });
  it("returns empty for a missing key", () => {
    expect(looseField("{}", "subject")).toBe("");
  });
});

describe("plainActionText", () => {
  it("drops markdown marks and folds whitespace", () => {
    expect(plainActionText("## Plan\n- **ship** it\n\n`now`")).toBe("Plan ship it now");
  });
});

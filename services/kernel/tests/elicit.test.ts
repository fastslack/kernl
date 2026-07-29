import { describe, expect, test } from "bun:test";
import { elicit, getCurrentServer, runWithServer } from "../src/core/elicit.js";

/**
 * Elicit helper tests. The "happy path" (form actually rendered to a
 * client) requires a live MCP session; here we validate the surface
 * that's testable without one:
 *   * No server context → `unsupported`.
 *   * Stub server context → calls through to elicitInput, returns
 *     accept/decline/cancel based on what the stub returns.
 */

interface StubServer {
  elicitInput: (params: unknown) => Promise<unknown>;
}

function withStub<T>(stub: StubServer, fn: () => Promise<T>): Promise<T> {
  // Cast through unknown — the elicit helper only touches `elicitInput`.
  return runWithServer(
    stub as unknown as Parameters<typeof runWithServer>[0],
    fn as unknown as () => Promise<void>,
  ) as unknown as Promise<T>;
}

describe("elicit", () => {
  test("returns unsupported when no server context is active", async () => {
    const out = await elicit({
      message: "test",
      fields: { x: { type: "string" } },
    });
    expect(out.action).toBe("unsupported");
    expect(getCurrentServer()).toBeNull();
  });

  test("returns accept with content when stub server returns accept", async () => {
    await withStub(
      {
        elicitInput: async () => ({
          action: "accept",
          content: { confirmed: true },
        }),
      },
      async () => {
        const out = await elicit<{ confirmed: boolean }>({
          message: "go?",
          fields: { confirmed: { type: "boolean" } },
          required: ["confirmed"],
        });
        expect(out.action).toBe("accept");
        if (out.action === "accept") {
          expect(out.content.confirmed).toBe(true);
        }
      },
    );
  });

  test("returns decline when stub server returns decline", async () => {
    await withStub(
      { elicitInput: async () => ({ action: "decline" }) },
      async () => {
        const out = await elicit({
          message: "go?",
          fields: { confirmed: { type: "boolean" } },
        });
        expect(out.action).toBe("decline");
      },
    );
  });

  test("returns cancel when stub server returns cancel", async () => {
    await withStub(
      { elicitInput: async () => ({ action: "cancel" }) },
      async () => {
        const out = await elicit({
          message: "go?",
          fields: { confirmed: { type: "boolean" } },
        });
        expect(out.action).toBe("cancel");
      },
    );
  });

  test("returns unsupported when elicitInput throws (no client capability)", async () => {
    await withStub(
      {
        elicitInput: async () => {
          throw new Error("Client does not support elicitation");
        },
      },
      async () => {
        const out = await elicit({
          message: "x",
          fields: { y: { type: "string" } },
        });
        expect(out.action).toBe("unsupported");
        if (out.action === "unsupported") {
          expect(out.reason).toContain("Client does not support");
        }
      },
    );
  });

  test("AsyncLocalStorage isolates contexts across concurrent runs", async () => {
    const stubA = { elicitInput: async () => ({ action: "accept", content: { who: "A" } }) };
    const stubB = { elicitInput: async () => ({ action: "accept", content: { who: "B" } }) };
    const [a, b] = await Promise.all([
      withStub(stubA, async () => {
        const r = await elicit<{ who: string }>({
          message: "?",
          fields: { who: { type: "string" } },
        });
        if (r.action === "accept") return r.content.who;
        return "?";
      }) as unknown as Promise<string>,
      withStub(stubB, async () => {
        const r = await elicit<{ who: string }>({
          message: "?",
          fields: { who: { type: "string" } },
        });
        if (r.action === "accept") return r.content.who;
        return "?";
      }) as unknown as Promise<string>,
    ]);
    expect(a).toBe("A");
    expect(b).toBe("B");
  });
});

import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initProviderStatus,
  markProviderExhausted,
  isProviderExhausted,
  clearProviderExhausted,
} from "../src/core/llm/provider-quota.js";

afterEach(() => clearProviderExhausted());

describe("provider quota persistence", () => {
  it("persists an exhausted provider for the rest of the day", () => {
    const db = new Database(":memory:");
    initProviderStatus(db);
    markProviderExhausted("openai");
    const row = db.prepare("SELECT exhausted FROM provider_status WHERE name = ?").get("openai") as { exhausted: number };
    expect(row.exhausted).toBe(1);
    db.close();
  });

  // The executor marks a provider exhausted in the middle of falling back to
  // the next one. A database it can no longer write to (closed on shutdown,
  // or by a test that booted the agents module before this one) must not
  // throw out of that fallback: the in-memory flag is what routes the retry.
  it("still marks and clears a provider when the database is gone", () => {
    const db = new Database(":memory:");
    initProviderStatus(db);
    db.close();

    expect(() => markProviderExhausted("lmstudio")).not.toThrow();
    expect(isProviderExhausted("lmstudio")).toBe(true);

    expect(() => clearProviderExhausted("lmstudio")).not.toThrow();
    expect(isProviderExhausted("lmstudio")).toBe(false);

    markProviderExhausted("lmstudio");
    expect(() => clearProviderExhausted()).not.toThrow();
    expect(isProviderExhausted("lmstudio")).toBe(false);
  });
});

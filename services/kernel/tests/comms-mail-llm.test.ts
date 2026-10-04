/**
 * The mail model: comms.llm.provider pins triage/analysis to one provider and
 * falls back to the default chain when it can't answer.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { installedHost, setHost } from "../src/sdk/host.js";
import { installTestHost } from "../src/sdk/testing.js";
import { mailLlmChat } from "../assets/extensions/people/comms/_module/mail-llm.js";

const kernelHost = installedHost()!;
let db: Database;
let calls: string[];

function host(pinned: "ok" | "fail" | "missing") {
  installTestHost({
    llm: () => ({ chat: async () => { calls.push("chain"); return { text: "from-chain" }; } }) as any,
    createPinnedLlmClient: (provider: string, model: string) => {
      if (pinned === "missing") return null;
      return {
        chat: async () => {
          calls.push(`${provider}/${model}`);
          if (pinned === "fail") throw new Error("minimax 503");
          return { text: "from-pinned" };
        },
      } as any;
    },
  });
}

const ask = () => mailLlmChat(db as any, {} as any, { system: "s", user: "u", caller: "email-triage" });

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)");
  calls = [];
});
afterEach(() => {
  setHost(kernelHost);
  db.close();
});

describe("mailLlmChat", () => {
  it("uses the default chain when no mail provider is set", async () => {
    host("ok");
    expect(await ask()).toBe("from-chain");
    expect(calls).toEqual(["chain"]);
  });

  it("pins to the configured provider and model", async () => {
    db.exec("INSERT INTO app_settings VALUES ('comms.llm.provider', 'minimax'), ('comms.llm.model', 'MiniMax-M3')");
    host("ok");
    expect(await ask()).toBe("from-pinned");
    expect(calls).toEqual(["minimax/MiniMax-M3"]);
  });

  it("falls back to the chain when the pinned provider fails or isn't connected", async () => {
    db.exec("INSERT INTO app_settings VALUES ('comms.llm.provider', 'minimax')");
    host("fail");
    expect(await ask()).toBe("from-chain");
    expect(calls).toEqual(["minimax/", "chain"]);

    calls = [];
    host("missing");
    expect(await ask()).toBe("from-chain");
    expect(calls).toEqual(["chain"]);
  });
});

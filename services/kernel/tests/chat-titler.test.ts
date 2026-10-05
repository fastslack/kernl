/**
 * Conversation titles by subject: the instant cut, the LLM rename at the
 * TITLE_AT counts, chosen titles left alone, failures falling back to the cut,
 * and the boot backfill.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { chatMigrations } from "../src/modules/chat/migrations/001_chat.js";
import { ChatService } from "../src/modules/chat/service.js";
import { ChatTitler, cleanTitle } from "../src/modules/chat/titler.js";
import { EventBus } from "../src/core/event-bus.js";
import type { KernelConfig } from "../src/core/config.js";

function stubConfig(): KernelConfig {
  return JSON.parse(JSON.stringify({
    language: "en",
    timezone: "UTC",
    agents: { defaultProvider: "", defaultModel: "", defaultModelChain: [] },
    claudeCode: {},
    chat: { defaultProvider: "claude-code", defaultModel: "", systemPrompt: "", maxEpisodeMessages: 200, contextBudget: 8000 },
  })) as KernelConfig;
}

type Call = { user: string; caller?: string; model?: string };

function setup(reply: () => Promise<string>) {
  const db = new Database(":memory:");
  runMigrations(db as unknown as never, "chat", chatMigrations);
  const svc = new ChatService(db as unknown as never, () => null, new EventBus(), stubConfig());
  const calls: Call[] = [];
  const client = {
    async chat(opts: Call) {
      calls.push(opts);
      return { text: await reply() };
    },
  };
  const titler = new ChatTitler(db as unknown as never, new EventBus(), () => client as never, "title-model");
  svc.setTitler(titler);

  const stream = {
    name: "claude-code",
    available: () => true,
    async chatCompletionStream(_m: string, sink: (ev: unknown) => void) {
      sink({ type: "assistant_text", text: "Sure, here is the plan." });
      return { finalText: "Sure, here is the plan.", tokensUsed: 3 };
    },
  };
  (svc as unknown as { providers: Map<string, unknown> }).providers = new Map([["claude-code", stream]]);
  return { db, svc, titler, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 10));
const say = (svc: ChatService, id: string, msg: string) => svc.chatStream(id, msg, () => {}, {});

describe("chat titles", () => {
  it("cuts first, then renames by subject after the first exchange", async () => {
    const { svc, calls } = setup(async () => '"Plan de viaje a Japón."');
    const ep = svc.createEpisode({ provider: "claude-code" });
    await say(svc, ep.id, "hola, quiero armar un viaje a Japón en abril con poco presupuesto");
    expect(svc.getEpisode(ep.id)!.title.startsWith("hola, quiero armar")).toBe(true);
    await flush();
    expect(svc.getEpisode(ep.id)!.title).toBe("Plan de viaje a Japón");
    expect(calls).toHaveLength(1);
    expect(calls[0].caller).toBe("chat.title");
    expect(calls[0].model).toBe("title-model");
    expect(calls[0].user).toContain("User: hola, quiero armar");
    expect(calls[0].user).toContain("Assistant: Sure, here is the plan.");
  });

  it("asks again at the sixth message and not in between", async () => {
    const { svc, calls } = setup(async () => "Some subject");
    const ep = svc.createEpisode({ provider: "claude-code" });
    for (const m of ["hi", "what's up", "let's talk taxes"]) {
      await say(svc, ep.id, m);
      await flush();
    }
    expect(calls).toHaveLength(2);
  });

  it("never renames a title a surface chose", async () => {
    const { svc, calls } = setup(async () => "Other");
    const ep = svc.createEpisode({ provider: "claude-code", title: "telegram 123" });
    await say(svc, ep.id, "hello");
    await flush();
    expect(svc.getEpisode(ep.id)!.title).toBe("telegram 123");
    expect(calls).toHaveLength(0);
  });

  it("keeps the cut when the LLM fails", async () => {
    const { svc } = setup(async () => { throw new Error("all providers down"); });
    const ep = svc.createEpisode({ provider: "claude-code" });
    await say(svc, ep.id, "budget for october");
    await flush();
    expect(svc.getEpisode(ep.id)!.title).toBe("budget for october");
  });

  it("backfills auto titles once, leaving chosen ones and empty chats alone", async () => {
    const { db, titler, calls } = setup(async () => "Named later");
    const ins = db.prepare(
      `INSERT INTO chat_episodes (id, title, title_auto, message_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-10-01', '2026-10-01')`,
    );
    const msg = db.prepare(
      `INSERT INTO chat_messages (id, episode_id, role, content, created_at) VALUES (?, ?, 'user', 'hola', '2026-10-01')`,
    );
    ins.run("auto", "hola", 1, 2); msg.run("m1", "auto");
    ins.run("chosen", "Mesa — first run", 0, 2); msg.run("m2", "chosen");
    ins.run("empty", "", 1, 0);

    expect(await titler.backfill()).toBe(1);
    const title = (id: string) => (db.prepare("SELECT title FROM chat_episodes WHERE id = ?").get(id) as { title: string }).title;
    expect(title("auto")).toBe("Named later");
    expect(title("chosen")).toBe("Mesa — first run");
    expect(await titler.backfill()).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("cleans what models wrap around a title", () => {
    expect(cleanTitle('Title: "Japan trip planning".\nExtra line')).toBe("Japan trip planning");
    expect(cleanTitle("**Presupuesto mensual**")).toBe("Presupuesto mensual");
    expect(cleanTitle("")).toBe("");
  });
});

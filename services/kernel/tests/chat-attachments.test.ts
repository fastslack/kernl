/**
 * Chat episodes with attachments: the stored envelope, the per-link
 * conversion of history into blocks (turn age, model caps, the claude_code
 * transcript), the text-only retry, the history API shape, the stream path
 * and the cleanup when an episode is deleted. Also the OpenAI-compatible
 * converter keeping history blocks in order.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { chatMigrations } from "../src/modules/chat/migrations/001_chat.js";
import { ChatService, _resetSoulCacheForTests } from "../src/modules/chat/service.js";
import { chatOperations } from "../src/modules/chat/operations.js";
import { encodeEnvelope, parseEnvelope, prepareHistory, materializeMessages } from "../src/modules/chat/attachment-history.js";
import { EventBus } from "../src/core/event-bus.js";
import * as providerHealth from "../src/core/llm/provider-health.js";
import { clearProviderExhausted, initProviderStatus } from "../src/core/llm/chat-adapters.js";
import { kernelMessagesToOpenAi, kernelMessagesToResponsesInput } from "../src/core/llm/chat-messages.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";
import type { ChatMessage, ContentBlock } from "../src/core/llm/chat-types.js";
import type { KernelConfig } from "../src/core/config.js";
import { attachmentsMigrations } from "../src/modules/attachments/migrations.js";
import { AttachmentService } from "../src/modules/attachments/service.js";
import { _setAttachmentServiceForTests } from "../src/modules/attachments/index.js";
import type { AttachmentDerived, AttachmentKind, AttachmentMeta, AttachmentRecord } from "../src/modules/attachments/types.js";

const work = mkdtempSync(join(tmpdir(), "kernl-chat-att-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function config(chain: Array<{ provider: string; model: string }> = []): KernelConfig {
  return JSON.parse(JSON.stringify({
    language: "en",
    timezone: "UTC",
    agents: { defaultProvider: "", defaultModel: "", defaultModelChain: chain },
    claudeCode: {},
    chat: { defaultProvider: "claude", defaultModel: "", systemPrompt: "", maxEpisodeMessages: 200, contextBudget: 8000 },
  })) as KernelConfig;
}

type Call = { name: string; messages: ChatMessage[] };

function provider(name: string, calls: Call[], replies: Array<() => unknown>, extra: Partial<ChatLlmProvider> = {}): ChatLlmProvider {
  let i = 0;
  return {
    name,
    available: () => true,
    async chatCompletion(messages) {
      calls.push({ name, messages: JSON.parse(JSON.stringify(messages)) });
      return replies[Math.min(i++, replies.length - 1)]() as never;
    },
    ...extra,
  };
}
const ok = (content: string) => () => ({ content, model: "fake", tokens_used: 5 });
const boom = (msg: string) => () => { throw new Error(msg); };

let db: Database;
let attachments: AttachmentService;
let dataDir: string;

function makeService(providers: Record<string, ChatLlmProvider>, chain: Array<{ provider: string; model: string }> = []) {
  const svc = new ChatService(db as unknown as never, () => null, new EventBus(), config(chain));
  const internals = svc as unknown as { providers: Map<string, unknown>; contextEngine: { retrieve: () => Promise<unknown> } };
  internals.providers = new Map(Object.entries(providers));
  internals.contextEngine.retrieve = async () => ({ contextText: "", method: "test", memories: [], totalTokens: 0 });
  return svc;
}

/** A ready attachment with its files on disk. */
function addAttachment(kind: AttachmentKind, filename: string, files: Record<string, string>, derived: AttachmentDerived, mime: string): string {
  const id = crypto.randomUUID();
  for (const [name, body] of Object.entries(files)) {
    const abs = join(dataDir, "attachments", id, name);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  const fill = (d: AttachmentDerived) => JSON.parse(JSON.stringify(d).replaceAll("{id}", id));
  db.prepare(
    `INSERT INTO attachments (id, kind, mime, filename, size_bytes, path, status, derived, error, bound_at, created_at)
     VALUES (?, ?, ?, ?, 10, ?, 'ready', ?, NULL, NULL, ?)`,
  ).run(id, kind, mime, filename, `attachments/${id}/${Object.keys(files)[0]}`, JSON.stringify(fill(derived)), new Date().toISOString());
  return id;
}
const addImage = (name = "foto.png") => addAttachment("image", name, { "original.png": "PNG", "normalized.jpg": "JPG" },
  { width: 10, height: 10, normalized: "attachments/{id}/normalized.jpg" }, "image/png");
const addPdf = (name = "informe.pdf") => addAttachment("document", name, { "original.pdf": "%PDF" }, { pages: 2, text: "texto pdf" }, "application/pdf");

const kinds = (m: ChatMessage) => (typeof m.content === "string" ? ["string"] : (m.content as ContentBlock[]).map((b) => b.type));

beforeEach(() => {
  _resetSoulCacheForTests();
  providerHealth._resetForTests();
  initProviderStatus(new Database(":memory:") as unknown as never);
  clearProviderExhausted();
  db = new Database(":memory:");
  runMigrations(db as unknown as never, "chat", chatMigrations);
  runMigrations(db as unknown as never, "attachments", attachmentsMigrations);
  dataDir = mkdtempSync(join(work, "data-"));
  attachments = new AttachmentService(db as unknown as never, { dataDir, setting: () => undefined });
  _setAttachmentServiceForTests(attachments);
});
afterEach(() => {
  _setAttachmentServiceForTests(null);
  attachments.stop();
  providerHealth._resetForTests();
  clearProviderExhausted();
});

describe("envelope", () => {
  it("stores ids next to the text and reads legacy rows", () => {
    const raw = encodeEnvelope({ text: "mirá", attachments: ["a", "b"] });
    expect(JSON.parse(raw)).toEqual({ text: "mirá", attachments: ["a", "b"] });
    expect(parseEnvelope(raw)).toEqual({ text: "mirá", attachments: ["a", "b"], images: [], documents: [] });
    expect(parseEnvelope(JSON.stringify({ text: "old", images: ["m/0.png"] }))?.images).toEqual(["m/0.png"]);
    expect(parseEnvelope('{"text":"typed json, nothing attached"}')).toBeNull();
    expect(parseEnvelope("plain")).toBeNull();
  });

  it("turn age counts the user turns after each message", () => {
    const rows = [
      { role: "user" as const, content: encodeEnvelope({ text: "t1", attachments: ["x"] }) },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "t2" },
      { role: "assistant" as const, content: "a2" },
      { role: "user" as const, content: encodeEnvelope({ text: "t3", attachments: ["y"] }) },
    ];
    const fakeRec = (id: string) => ({ id, kind: "document", filename: `${id}.txt`, mime: "text/plain", derived: { text: id }, status: "ready", path: "" }) as unknown as AttachmentRecord;
    const { messages, slots } = prepareHistory(rows, (ids) => ids.map(fakeRec));
    expect(slots.map((s) => [s.index, s.turnAge])).toEqual([[0, 2], [4, 0]]);
    expect(messages[0]).toEqual({ role: "user", content: "t1" });
    const filled = materializeMessages(messages, slots, { vision: false, pdf: false, video: false });
    expect(filled.messages[0].content).toEqual([
      { type: "text", text: "[Adjunto: x.txt · documento]" },
      { type: "text", text: "x" },
      { type: "text", text: "t1" },
    ]);
  });
});

describe("chat() with attachment_ids", () => {
  it("binds, stores the envelope and sends native blocks to a capable model", async () => {
    const calls: Call[] = [];
    const svc = makeService({ claude: provider("claude", calls, [ok("veo una foto")]) });
    const ops = chatOperations({ chatService: svc });
    const ep = svc.createEpisode({ provider: "claude" });
    const img = addImage();
    const pdf = addPdf();

    await ops["chat.message.send"]({ episode_id: ep.id, message: "¿qué es esto?", attachment_ids: [img, pdf], skip_extraction: true });

    const last = calls[0].messages.at(-1)!;
    expect(kinds(last)).toEqual(["text", "image", "text", "document", "text"]);
    expect((last.content as ContentBlock[]).at(-1)).toEqual({ type: "text", text: "¿qué es esto?" });
    const stored = svc.getMessages(ep.id)[0];
    expect(JSON.parse(stored.content)).toEqual({ text: "¿qué es esto?", attachments: [img, pdf] });
    expect(attachments.get(img)!.bound_at).not.toBeNull();
  });

  it("an attachment-only message is accepted; a bad id is a 400 and stores nothing", async () => {
    const calls: Call[] = [];
    const svc = makeService({ claude: provider("claude", calls, [ok("ok")]) });
    const ops = chatOperations({ chatService: svc });
    const ep = svc.createEpisode({ provider: "claude" });

    await ops["chat.message.send"]({ episode_id: ep.id, attachment_ids: [addPdf()], skip_extraction: true });
    expect(kinds(calls[0].messages.at(-1)!)).toEqual(["text", "document"]);

    const before = svc.getMessages(ep.id).length;
    await expect(ops["chat.message.send"]({ episode_id: ep.id, message: "x", attachment_ids: [crypto.randomUUID()] }))
      .rejects.toMatchObject({ status: 400 });
    await expect(ops["chat.message.send"]({ episode_id: ep.id, message: "x", attachment_ids: "nope" }))
      .rejects.toMatchObject({ status: 400 });
    expect(svc.getMessages(ep.id).length).toBe(before);
  });

  it("history turns keep their attachments as blocks with their turn age", async () => {
    const calls: Call[] = [];
    const svc = makeService({ claude: provider("claude", calls, [ok("r")]) });
    const ep = svc.createEpisode({ provider: "claude" });
    const img = addImage();
    await svc.chat(ep.id, "primera", { attachmentIds: [img], skipExtraction: true });
    await svc.chat(ep.id, "segunda", { skipExtraction: true });
    await svc.chat(ep.id, "tercera", { skipExtraction: true });
    await svc.chat(ep.id, "cuarta", { skipExtraction: true });

    // Turn 2 and 3: the image is 1 and 2 turns old — still native.
    expect(kinds(calls[1].messages[0])).toEqual(["text", "image", "text"]);
    expect(kinds(calls[2].messages[0])).toEqual(["text", "image", "text"]);
    // Turn 4: 3 turns old — text stand-in.
    expect(kinds(calls[3].messages[0])).toEqual(["text", "text", "text"]);
    expect((calls[3].messages[0].content as ContentBlock[])[1]).toEqual({ type: "text", text: "[imagen: foto.png, 10×10]" });
  });

  it("rebuilds per fallback link: a text-only model gets the text form", async () => {
    const calls: Call[] = [];
    const svc = makeService({
      claude: provider("claude", calls, [boom("claude API error 503: overloaded")]),
      groq: provider("groq", calls, [ok("from groq")]),
    }, [{ provider: "groq", model: "openai/gpt-oss-120b" }]);
    const ep = svc.createEpisode({ provider: "claude" });
    await svc.chat(ep.id, "leé esto", { attachmentIds: [addImage(), addPdf()], skipExtraction: true });

    expect(calls.map((c) => c.name)).toEqual(["claude", "groq"]);
    expect(kinds(calls[0].messages.at(-1)!)).toContain("image");
    expect(kinds(calls[1].messages.at(-1)!)).toEqual(["text", "text", "text", "text", "text"]);
    expect(JSON.stringify(calls[1].messages)).toContain("texto pdf");
  });

  it("retries once with attachments as text when the provider refuses a block", async () => {
    const calls: Call[] = [];
    const svc = makeService({
      claude: provider("claude", calls, [boom("claude API error 400: image exceeds 5 MB maximum"), ok("fine as text")]),
    });
    const ep = svc.createEpisode({ provider: "claude" });
    const res = await svc.chat(ep.id, "mirá", { attachmentIds: [addImage()], skipExtraction: true });

    expect(res.message.content).toBe("fine as text");
    expect(calls).toHaveLength(2);
    expect(kinds(calls[0].messages.at(-1)!)).toContain("image");
    expect(kinds(calls[1].messages.at(-1)!)).not.toContain("image");
  });

  it("claude_code: the current turn goes native, past turns as text", async () => {
    const calls: Call[] = [];
    const svc = makeService({ claude_code: provider("claude_code", calls, [ok("r")], { supportsToolLoop: false }) });
    const ep = svc.createEpisode({ provider: "claude_code" });
    const first = addImage("vieja.png");
    await svc.chat(ep.id, "uno", { attachmentIds: [first], skipExtraction: true });
    await svc.chat(ep.id, "dos", { attachmentIds: [addImage("nueva.png")], skipExtraction: true });

    const msgs = calls[1].messages;
    expect(kinds(msgs[0])).toEqual(["text", "text", "text"]);
    expect(kinds(msgs.at(-1)!)).toEqual(["text", "image", "text"]);
  });
});

describe("history API and cleanup", () => {
  it("chat.messages.list adds attachment metas to the user messages that carry them", async () => {
    const svc = makeService({ claude: provider("claude", [], [ok("r")]) });
    const ops = chatOperations({ chatService: svc });
    const ep = svc.createEpisode({ provider: "claude" });
    const img = addImage();
    await svc.chat(ep.id, "con foto", { attachmentIds: [img], skipExtraction: true });

    const list = (await ops["chat.messages.list"]({ episode_id: ep.id })) as Array<{ role: string; content: string; attachments?: AttachmentMeta[] }>;
    expect(list[0].attachments?.map((a) => [a.id, a.kind, a.filename])).toEqual([[img, "image", "foto.png"]]);
    expect(list[0].attachments?.[0]).not.toHaveProperty("path");
    expect(list[1].attachments).toBeUndefined();
  });

  it("deleting an episode deletes its attachments", async () => {
    const svc = makeService({ claude: provider("claude", [], [ok("r")]) });
    const ep = svc.createEpisode({ provider: "claude" });
    const img = addImage();
    await svc.chat(ep.id, "x", { attachmentIds: [img], skipExtraction: true });
    expect(svc.deleteEpisode(ep.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(attachments.get(img)).toBeNull();
    expect(existsSync(join(dataDir, "attachments", img))).toBe(false);
  });
});

describe("stream path", () => {
  it("sends this turn's attachments as blocks and stores the envelope", async () => {
    const seen: unknown[] = [];
    const svc = makeService({});
    const fake = {
      name: "claude-code",
      available: () => true,
      async chatCompletionStream(content: unknown, sink: (ev: unknown) => void) {
        seen.push(content);
        sink({ type: "assistant_text", text: "visto" });
        return { finalText: "visto", tokensUsed: 3 };
      },
    };
    (svc as unknown as { providers: Map<string, unknown> }).providers = new Map([["claude-code", fake]]);
    const ep = svc.createEpisode({ provider: "claude-code" });
    const pdf = addPdf();

    await svc.chatStream(ep.id, "resumí", () => {}, { attachmentIds: [pdf] });

    const content = seen[0] as ContentBlock[];
    expect(content.map((b) => b.type)).toEqual(["text", "document", "text"]);
    expect(content.at(-1)).toEqual({ type: "text", text: "resumí" });
    expect(parseEnvelope(svc.getMessages(ep.id)[0].content)?.attachments).toEqual([pdf]);
  });

  it("plain text still goes as a string", async () => {
    const seen: unknown[] = [];
    const svc = makeService({});
    const fake = {
      name: "claude-code",
      available: () => true,
      async chatCompletionStream(content: unknown) {
        seen.push(content);
        return { finalText: "ok", tokensUsed: 1 };
      },
    };
    (svc as unknown as { providers: Map<string, unknown> }).providers = new Map([["claude-code", fake]]);
    const ep = svc.createEpisode({ provider: "claude-code" });
    await svc.chatStream(ep.id, "hola", () => {});
    expect(seen[0]).toBe("hola");
  });
});

describe("OpenAI-compatible conversion", () => {
  const blocks: ContentBlock[] = [
    { type: "text", text: "[Adjunto: a.png · imagen]" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    { type: "text", text: "[Adjunto: b.pdf · documento]" },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "UERG" } },
    { type: "text", text: "pregunta" },
  ];

  it("keeps history user blocks in order, images included, PDFs as a note", () => {
    const out = kernelMessagesToOpenAi([
      { role: "user", content: blocks },
      { role: "assistant", content: "respuesta" },
      { role: "user", content: "siguiente" },
    ]);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[Adjunto: a.png · imagen]" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        { type: "text", text: "[Adjunto: b.pdf · documento]" },
        { type: "text", text: "[pdf adjunto: este modelo no puede leerlo]" },
        { type: "text", text: "pregunta" },
      ],
    });
    expect(out[2]).toEqual({ role: "user", content: "siguiente" });
  });

  it("text-only block lists become one string, one block per line", () => {
    const out = kernelMessagesToOpenAi([{ role: "user", content: [{ type: "text", text: "[Adjunto: x]" }, { type: "text", text: "hola" }] }]);
    expect(out[0]).toEqual({ role: "user", content: "[Adjunto: x]\nhola" });
  });

  it("the Responses API input keeps the same order", () => {
    const { input } = kernelMessagesToResponsesInput([{ role: "user", content: blocks }]);
    expect((input[0].content as Array<{ type: string }>).map((c) => c.type))
      .toEqual(["input_text", "input_image", "input_text", "input_text", "input_text"]);
  });
});

/**
 * Attachments → LLM content blocks: the caps × turn age × kind table, the
 * header line, old-turn truncation, the request-wide native cap, the
 * per-provider caps resolution and the helpers chat/agents lean on.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentHeader,
  attachmentNote,
  blocksText,
  buildAttachmentBlocks,
  buildRequestAttachmentBlocks,
  formatDuration,
  hasNativeBlocks,
  looksLikeNativeBlockRejection,
  MAX_NATIVE_IMAGES,
  OLD_TEXT_LIMIT,
  RECENT_TURNS,
  withoutNativeBlocks,
} from "../src/modules/attachments/blocks.js";
import { resolveInputCaps, TEXT_ONLY_CAPS } from "../src/core/llm/input-caps.js";
import type { ContentBlock } from "../src/core/llm/chat-types.js";
import type { AttachmentRecord } from "../src/modules/attachments/types.js";

const work = mkdtempSync(join(tmpdir(), "kernl-blocks-"));
const absPath = (rel: string) => join(work, rel);
const opts = { absPath };

function file(rel: string, bytes: Buffer | number): void {
  const abs = absPath(rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  if (typeof bytes === "number") {
    writeFileSync(abs, "");
    truncateSync(abs, bytes); // sparse: only the size matters until it is read
  } else {
    writeFileSync(abs, bytes);
  }
}

let n = 0;
function rec(over: Partial<AttachmentRecord> & Pick<AttachmentRecord, "kind" | "mime" | "path">): AttachmentRecord {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    filename: over.path.split("/").pop()!,
    size_bytes: 10,
    status: "ready",
    error: null,
    derived: {},
    bound_at: null,
    created_at: "2026-10-04T00:00:00.000Z",
    ...over,
  };
}

const LONG = "x".repeat(OLD_TEXT_LIMIT + 500);
let image: AttachmentRecord, pdf: AttachmentRecord, docx: AttachmentRecord, video: AttachmentRecord, longPdf: AttachmentRecord;

beforeAll(() => {
  file("attachments/img/original.png", Buffer.from("PNGDATA"));
  file("attachments/img/normalized.jpg", Buffer.from("JPGDATA"));
  file("attachments/pdf/original.pdf", Buffer.from("%PDF-1.4"));
  file("attachments/docx/original.docx", Buffer.from("PK"));
  file("attachments/vid/original.mp4", Buffer.from("MP4"));
  file("attachments/vid/frame-01.jpg", Buffer.from("F1"));
  file("attachments/vid/frame-02.jpg", Buffer.from("F2"));
  image = rec({ kind: "image", mime: "image/png", path: "attachments/img/original.png", filename: "foto.png",
    derived: { width: 800, height: 600, normalized: "attachments/img/normalized.jpg" } });
  pdf = rec({ kind: "document", mime: "application/pdf", path: "attachments/pdf/original.pdf", filename: "informe.pdf",
    derived: { pages: 12, text: "texto del informe" } });
  longPdf = rec({ kind: "document", mime: "application/pdf", path: "attachments/pdf/original.pdf", filename: "largo.pdf",
    derived: { pages: 40, text: LONG } });
  docx = rec({ kind: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    path: "attachments/docx/original.docx", filename: "notas.docx", derived: { text: "notas de la reunión" } });
  video = rec({ kind: "video", mime: "video/mp4", path: "attachments/vid/original.mp4", filename: "clip.mp4",
    derived: { duration_s: 42, width: 768, height: 432, transcript: "[00:01] hola", frames: ["attachments/vid/frame-01.jpg", "attachments/vid/frame-02.jpg"] } });
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

const ALL = { vision: true, pdf: true, video: false };
const VISION = { vision: true, pdf: false, video: false };

/** Compact shape of a block list: "text:<header | first 30 chars>" | "image:<media>" | "document". */
function shape(blocks: ContentBlock[]): string[] {
  return blocks.map((b) => {
    if (b.type === "text") return `text:${b.text.startsWith("[Adjunto:") ? b.text : b.text.slice(0, 30)}`;
    if (b.type === "image") return `image:${b.source.media_type}`;
    return b.type;
  });
}

describe("header", () => {
  it("names the file, kind and its key measure", () => {
    expect(attachmentHeader(pdf)).toBe("[Adjunto: informe.pdf · documento · 12 págs]");
    expect(attachmentHeader(image)).toBe("[Adjunto: foto.png · imagen · 800×600]");
    expect(attachmentHeader(video)).toBe("[Adjunto: clip.mp4 · video · 0:42]");
    expect(attachmentHeader(docx)).toBe("[Adjunto: notas.docx · documento]");
    expect(formatDuration(125)).toBe("2:05");
    expect(attachmentNote([pdf, image])).toBe("[Adjunto: informe.pdf · documento · 12 págs] [Adjunto: foto.png · imagen · 800×600]");
  });
});

describe("caps × age × kind", () => {
  const recent = 0;
  const old = RECENT_TURNS;
  const cases: Array<[string, () => AttachmentRecord, typeof ALL, number, string[]]> = [
    // image
    ["image, vision, recent → normalized jpg block", () => image, ALL, recent, ["text:[Adjunto: foto.png · imagen · 800×600]", "image:image/jpeg"]],
    ["image, no vision, recent → stand-in", () => image, TEXT_ONLY_CAPS, recent, ["text:[Adjunto: foto.png · imagen · 800×600]", "text:[imagen: foto.png, 800×600]"]],
    ["image, vision, old → stand-in", () => image, ALL, old, ["text:[Adjunto: foto.png · imagen · 800×600]", "text:[imagen: foto.png, 800×600]"]],
    // pdf
    ["pdf, pdf cap, recent → document block", () => pdf, ALL, recent, ["text:[Adjunto: informe.pdf · documento · 12 págs]", "document"]],
    ["pdf, no pdf cap, recent → extracted text", () => pdf, VISION, recent, ["text:[Adjunto: informe.pdf · documento · 12 págs]", "text:texto del informe"]],
    ["pdf, pdf cap, old → extracted text", () => pdf, ALL, old, ["text:[Adjunto: informe.pdf · documento · 12 págs]", "text:texto del informe"]],
    // docx
    ["docx, recent → full text", () => docx, ALL, recent, ["text:[Adjunto: notas.docx · documento]", "text:notas de la reunión"]],
    ["docx, old → text", () => docx, TEXT_ONLY_CAPS, old, ["text:[Adjunto: notas.docx · documento]", "text:notas de la reunión"]],
    // video
    ["video, vision, recent → frames + transcript", () => video, ALL, recent,
      ["text:[Adjunto: clip.mp4 · video · 0:42]", "image:image/jpeg", "image:image/jpeg", "text:Transcripción:\n[00:01] hola"]],
    ["video, no vision, recent → transcript only", () => video, TEXT_ONLY_CAPS, recent,
      ["text:[Adjunto: clip.mp4 · video · 0:42]", "text:Transcripción:\n[00:01] hola"]],
    ["video, vision, old → transcript + stand-in", () => video, ALL, old,
      ["text:[Adjunto: clip.mp4 · video · 0:42]", "text:Transcripción:\n[00:01] hola\n[v"]],
  ];
  for (const [name, get, caps, age, expected] of cases) {
    it(name, () => {
      expect(shape(buildAttachmentBlocks([get()], caps, age, opts))).toEqual(expected);
    });
  }

  it("reads the file it points at, base64-encoded", () => {
    const blocks = buildAttachmentBlocks([image, pdf], ALL, 0, opts);
    const img = blocks.find((b) => b.type === "image") as { source: { data: string } };
    const doc = blocks.find((b) => b.type === "document") as { source: { data: string } };
    expect(Buffer.from(img.source.data, "base64").toString()).toBe("JPGDATA");
    expect(Buffer.from(doc.source.data, "base64").toString()).toBe("%PDF-1.4");
  });

  it("an image description replaces the stand-in", () => {
    const described = { ...image, derived: { ...image.derived, description: "Un perro en la playa." } };
    expect(blocksText(buildAttachmentBlocks([described], TEXT_ONLY_CAPS, 0, opts))).toContain("Un perro en la playa.");
  });

  it("an old video says its length and frame count", () => {
    expect(blocksText(buildAttachmentBlocks([video], ALL, RECENT_TURNS, opts))).toContain("[video: 0:42, 2 cuadros]");
  });

  it("old turns truncate long text and say how to get the rest; recent turns don't", () => {
    const oldText = blocksText(buildAttachmentBlocks([longPdf], VISION, RECENT_TURNS, opts));
    expect(oldText).toContain(`[…recortado a ${OLD_TEXT_LIMIT} de ${LONG.length} caracteres`);
    expect(oldText.length).toBeLessThan(LONG.length);
    const recentText = blocksText(buildAttachmentBlocks([longPdf], VISION, 0, opts));
    expect(recentText).toContain(LONG);
  });

  it("a missing file falls back to the text form", () => {
    const gone = rec({ kind: "image", mime: "image/png", path: "attachments/gone/original.png", filename: "gone.png" });
    expect(shape(buildAttachmentBlocks([gone], ALL, 0, opts))).toEqual(["text:[Adjunto: gone.png · imagen]", "text:[imagen: gone.png]"]);
  });

  it("without an attachment service everything is text", () => {
    expect(hasNativeBlocks(buildAttachmentBlocks([image, pdf], ALL, 0))).toBe(false);
  });
});

describe("request-wide native cap", () => {
  it(`more than ${MAX_NATIVE_IMAGES} native images: the oldest turns degrade first`, () => {
    const many = Array.from({ length: 12 }, () => ({ ...image, id: crypto.randomUUID() }));
    const [older, newer] = buildRequestAttachmentBlocks(
      [{ records: many, turnAge: 2 }, { records: many, turnAge: 0 }], ALL, opts);
    const count = (bs: ContentBlock[]) => bs.filter((b) => b.type === "image").length;
    expect(count(newer)).toBe(12);
    expect(count(older)).toBe(MAX_NATIVE_IMAGES - 12);
    // Inside the degraded turn, earlier attachments go first.
    expect(older.findIndex((b) => b.type === "image")).toBeGreaterThan(older.findIndex((b) => b.type === "text" && b.text.startsWith("[imagen")));
  });

  it("more than 30 MB of native payload: the oldest degrades", () => {
    file("attachments/big1/original.pdf", 16 * 1024 * 1024);
    file("attachments/big2/original.pdf", 16 * 1024 * 1024);
    const big1 = rec({ kind: "document", mime: "application/pdf", path: "attachments/big1/original.pdf", filename: "a.pdf", derived: { text: "A" } });
    const big2 = rec({ kind: "document", mime: "application/pdf", path: "attachments/big2/original.pdf", filename: "b.pdf", derived: { text: "B" } });
    const [older, newer] = buildRequestAttachmentBlocks([{ records: [big1], turnAge: 1 }, { records: [big2], turnAge: 0 }], ALL, opts);
    expect(shape(older)).toEqual(["text:[Adjunto: a.pdf · documento]", "text:A"]);
    expect(shape(newer)).toEqual(["text:[Adjunto: b.pdf · documento]", "document"]);
  });
});

describe("input caps", () => {
  it("Anthropic API and Claude Code take images and PDFs; nobody takes video", () => {
    expect(resolveInputCaps("claude")).toEqual({ vision: true, pdf: true, video: false });
    expect(resolveInputCaps("claude_code", "sonnet")).toEqual({ vision: true, pdf: true, video: false });
    expect(resolveInputCaps("claude-code")).toEqual({ vision: true, pdf: true, video: false });
  });

  it("OpenAI-compatible: vision by catalog entry or model name, never PDF", () => {
    expect(resolveInputCaps("gemini", "gemini-3.8-flash")).toEqual({ vision: true, pdf: false, video: false });
    expect(resolveInputCaps("groq", "openai/gpt-oss-120b")).toEqual({ vision: false, pdf: false, video: false });
    expect(resolveInputCaps("openrouter", "qwen/qwen2.5-vl-72b")).toEqual({ vision: true, pdf: false, video: false });
  });

  it("an unknown provider gets text only", () => {
    expect(resolveInputCaps("some-extension")).toEqual(TEXT_ONLY_CAPS);
  });
});

describe("helpers", () => {
  it("recognises a refused block, not a quota or network error", () => {
    expect(looksLikeNativeBlockRejection(new Error("claude API error 400: image exceeds 5 MB maximum"))).toBe(true);
    expect(looksLikeNativeBlockRejection(new Error("groq API error 400: model does not support image input"))).toBe(true);
    expect(looksLikeNativeBlockRejection(new Error("API error 429: rate limited"))).toBe(false);
    expect(looksLikeNativeBlockRejection(new Error("fetch failed"))).toBe(false);
  });

  it("strips native blocks from persisted messages", () => {
    const blocks = buildAttachmentBlocks([image, pdf], ALL, 0, opts);
    const [m] = withoutNativeBlocks([{ role: "user", content: blocks }]);
    expect(hasNativeBlocks(m.content as ContentBlock[])).toBe(false);
    expect(blocksText(m.content as ContentBlock[])).toContain("[imagen adjunto omitido]");
  });
});

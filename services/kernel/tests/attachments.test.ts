/**
 * Chat attachments: raw upload, type detection, caps, serving, binding,
 * the orphan sweep and per-kind processing (with small generated fixtures;
 * the image and video cases need ffmpeg and are skipped without it).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import archiver from "archiver";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { probeMediaTool } from "../src/core/media-tools.js";
import { attachmentsMigrations } from "../src/modules/attachments/migrations.js";
import { AttachmentService } from "../src/modules/attachments/service.js";
import { registerAttachmentRoutes } from "../src/modules/attachments/routes.js";
import { detectType } from "../src/modules/attachments/detect.js";
import { frameCount } from "../src/modules/attachments/processor.js";
import { formatWhisperSegments } from "../src/modules/attachments/transcribe.js";
import { TEXT_CAP } from "../src/modules/attachments/extract.js";
import type { AttachmentMeta } from "../src/modules/attachments/types.js";

const HAS_FFMPEG = (await probeMediaTool("ffmpeg", { fresh: true })).available
  && (await probeMediaTool("ffprobe", { fresh: true })).available;

const work = mkdtempSync(join(tmpdir(), "kernl-attachments-"));
const dataDir = join(work, "data");
mkdirSync(dataDir, { recursive: true });
// An empty models dir: the video case must not depend on whatever whisper
// model this machine happens to have downloaded.
const modelsDir = join(work, "whisper-models");
mkdirSync(modelsDir, { recursive: true });
const prevModelsDir = process.env.WHISPERCPP_MODELS_DIR;
process.env.WHISPERCPP_MODELS_DIR = modelsDir;

const settings: Record<string, string> = {};
const described: string[] = [];
const db = new Database(":memory:");
runMigrations(db, "attachments", attachmentsMigrations);
const service = new AttachmentService(db, {
  dataDir,
  setting: (k) => settings[k],
  describeImage: async (image, mime, model) => {
    described.push(`${model}:${mime}:${image.length > 0}`);
    return "una imagen de prueba";
  },
});

const server = new KernelHttpServer({
  config: {
    dashboard: { port: 0, bind: "127.0.0.1" },
    auth: { token: "" },
    cors: { allowedOrigins: [] },
  } as unknown as KernelConfig,
});
registerAttachmentRoutes(server, service);
let base = "";

beforeAll(async () => {
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await server.stop();
  service.stop();
  if (prevModelsDir === undefined) delete process.env.WHISPERCPP_MODELS_DIR;
  else process.env.WHISPERCPP_MODELS_DIR = prevModelsDir;
  rmSync(work, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────

// 1×1 transparent PNG.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A one-page PDF with real text, offsets computed so the xref is valid. */
function makePdf(text: string, pages = 1): Buffer {
  const objs: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  const fontId = 3 + pages * 2;
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text} ${i + 1}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A minimal .docx: content types, package rels and one paragraph. */
function makeDocx(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = archiver("zip");
    const chunks: Buffer[] = [];
    zip.on("data", (c: Buffer) => chunks.push(c));
    zip.on("end", () => resolve(Buffer.concat(chunks)));
    zip.on("error", reject);
    zip.append(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      { name: "[Content_Types].xml" },
    );
    zip.append(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      { name: "_rels/.rels" },
    );
    zip.append(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      { name: "word/document.xml" },
    );
    void zip.finalize();
  });
}

async function upload(body: Buffer | string, filename: string): Promise<Response> {
  return fetch(`${base}/api/attachments?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: typeof body === "string" ? body : new Uint8Array(body),
  });
}

async function uploadReady(body: Buffer | string, filename: string): Promise<AttachmentMeta> {
  const r = await upload(body, filename);
  expect(r.status).toBe(200);
  const meta = (await r.json()) as AttachmentMeta;
  await service.whenProcessed(meta.id);
  const after = await fetch(`${base}/api/attachments/${meta.id}`);
  return (await after.json()) as AttachmentMeta;
}

const attachmentDirs = () => (existsSync(join(dataDir, "attachments")) ? readdirSync(join(dataDir, "attachments")) : []);

// ── Pure helpers ──────────────────────────────────────────

describe("attachment helpers", () => {
  it("detects by magic bytes, not by name", () => {
    expect(detectType(PNG_1PX, "photo.pdf")?.mime).toBe("image/png");
    expect(detectType(Buffer.from("%PDF-1.4 ..."), "x.bin")?.kind).toBe("document");
    expect(detectType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "logo.svg")).toBeNull();
    expect(detectType(Buffer.from("<svg/>"), "logo.png")).toBeNull();
    expect(detectType(Buffer.from("hola"), "nota.md")?.mime).toBe("text/markdown");
    expect(detectType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), "archive.zip")).toBeNull();
  });

  it("keeps the frame count between 8 and 16", () => {
    expect(frameCount(2)).toBe(12);
    expect(frameCount(170)).toBe(12);
    expect(frameCount(0)).toBe(12);
  });

  it("turns whisper segments into [mm:ss] lines", () => {
    const out = formatWhisperSegments(
      "[00:00:00.000 --> 00:00:02.500]   Hola, ¿qué tal?\n[00:01:05.120 --> 00:01:07.000]  Chau.\n[00:01:08.000 --> 00:01:09.000]   \nwhisper_print_timings: x",
    );
    expect(out).toBe("[00:00] Hola, ¿qué tal?\n[01:05] Chau.");
  });
});

// ── API ───────────────────────────────────────────────────

describe("POST /api/attachments", () => {
  it("streams a text file, processes it and serves it as a download", async () => {
    const meta = await uploadReady("línea uno\nlínea dos\n", "notas.txt");
    expect(meta.kind).toBe("document");
    expect(meta.mime).toBe("text/plain");
    expect(meta.status).toBe("ready");
    expect(meta.derived.text).toContain("línea dos");
    expect(meta.filename).toBe("notas.txt");

    const file = await fetch(`${base}/api/attachments/${meta.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
    expect(file.headers.get("content-disposition")).toStartWith("attachment;");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await file.text()).toBe("línea uno\nlínea dos\n");
  });

  it("answers with status processing before the work is done", async () => {
    const r = await upload("a,b\n1,2\n", "tabla.csv");
    const meta = (await r.json()) as AttachmentMeta;
    expect(meta.status).toBe("processing");
    expect(meta.mime).toBe("text/csv");
    await service.whenProcessed(meta.id);
  });

  it("refuses a body over the cap for its kind and leaves nothing on disk", async () => {
    const before = attachmentDirs().length;
    settings["attachments.max_document_mb"] = "0.005"; // ~5 KB
    try {
      const r = await upload("x".repeat(20_000), "grande.txt");
      expect(r.status).toBe(413);
      expect(((await r.json()) as { error: string }).error).toContain("documentos");
    } finally {
      delete settings["attachments.max_document_mb"];
    }
    expect(attachmentDirs().length).toBe(before);
  });

  it("refuses lying magic bytes", async () => {
    const svg = await upload("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "foto.png");
    expect(svg.status).toBe(415);
    const binaryAsText = await upload(Buffer.from([0x68, 0x6f, 0x00, 0x01, 0x02]), "notas.txt");
    expect(binaryAsText.status).toBe(415);
    // Invalid UTF-8 past the detection window is caught once the file is in.
    const lateGarbage = Buffer.concat([Buffer.from("a".repeat(10_000)), Buffer.from([0xff, 0xfe, 0xfd])]);
    const late = await upload(lateGarbage, "log.txt");
    expect(late.status).toBe(415);
    const zip = await upload(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]), "backup.zip");
    expect(zip.status).toBe(415);
  });

  it("refuses an empty body", async () => {
    const r = await upload(Buffer.alloc(0), "vacio.txt");
    expect(r.status).toBe(400);
  });
});

describe("GET / DELETE /api/attachments/:id", () => {
  it("answers 400 for anything that is not a uuid v4", async () => {
    for (const bad of ["123", "..%2F..%2Fkernel.db", "00000000-0000-0000-0000-000000000000"]) {
      expect((await fetch(`${base}/api/attachments/${bad}`)).status).toBe(400);
      expect((await fetch(`${base}/api/attachments/${bad}/file`)).status).toBe(400);
      expect((await fetch(`${base}/api/attachments/${bad}`, { method: "DELETE" })).status).toBe(400);
    }
  });

  it("answers 404 for an unknown id", async () => {
    const id = crypto.randomUUID();
    expect((await fetch(`${base}/api/attachments/${id}`)).status).toBe(404);
    expect((await fetch(`${base}/api/attachments/${id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("deletes an unbound attachment and refuses a bound one", async () => {
    const a = await uploadReady("borrar", "a.txt");
    const del = await fetch(`${base}/api/attachments/${a.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(existsSync(join(dataDir, "attachments", a.id))).toBe(false);
    expect(service.get(a.id)).toBeNull();

    const b = await uploadReady("conservar", "b.txt");
    service.bind([b.id]);
    const refused = await fetch(`${base}/api/attachments/${b.id}`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(service.get(b.id)).not.toBeNull();
  });
});

describe("bind()", () => {
  it("binds ready ids and is all-or-nothing on a bad one", async () => {
    const a = await uploadReady("uno", "uno.txt");
    expect(() => service.bind([a.id, crypto.randomUUID()])).toThrow(/desconocido/);
    expect(service.get(a.id)!.bound_at).toBeNull();
    const bound = service.bind([a.id, a.id]);
    expect(bound).toHaveLength(1);
    expect(bound[0].bound_at).toBeTruthy();
    expect(service.get(a.id)!.bound_at).toBeTruthy();
  });

  it("refuses an id still processing and one that failed", () => {
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO attachments (id, kind, mime, filename, size_bytes, path, status, derived, created_at) VALUES (?, 'document', 'text/plain', 'p.txt', 1, ?, 'processing', '{}', ?)",
    ).run(id, `attachments/${id}/original.txt`, new Date().toISOString());
    expect(() => service.bind([id])).toThrow(/procesando/);
    db.prepare("UPDATE attachments SET status = 'failed', error = 'ilegible' WHERE id = ?").run(id);
    expect(() => service.bind([id])).toThrow(/ilegible/);
    db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  });

  it("refuses more than 10 attachments", () => {
    const ids = Array.from({ length: 11 }, () => crypto.randomUUID());
    expect(() => service.bind(ids)).toThrow(/hasta 10/);
  });
});

describe("orphan sweep", () => {
  it("removes unbound attachments older than a day and keeps bound ones", async () => {
    const orphan = await uploadReady("huérfano", "o.txt");
    const kept = await uploadReady("enviado", "k.txt");
    const fresh = await uploadReady("recién", "f.txt");
    service.bind([kept.id]);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE attachments SET created_at = ? WHERE id IN (?, ?)").run(old, orphan.id, kept.id);

    const removed = await service.sweepOrphans();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(service.get(orphan.id)).toBeNull();
    expect(existsSync(join(dataDir, "attachments", orphan.id))).toBe(false);
    expect(service.get(kept.id)).not.toBeNull();
    expect(service.get(fresh.id)).not.toBeNull();
  });

  it("re-queues rows a restart left processing", async () => {
    const id = crypto.randomUUID();
    const rel = `attachments/${id}/original.txt`;
    mkdirSync(join(dataDir, "attachments", id), { recursive: true });
    writeFileSync(join(dataDir, rel), "texto pendiente");
    db.prepare(
      "INSERT INTO attachments (id, kind, mime, filename, size_bytes, path, status, derived, created_at) VALUES (?, 'document', 'text/plain', 'p.txt', 15, ?, 'processing', '{}', ?)",
    ).run(id, rel, new Date().toISOString());
    expect(service.requeuePending()).toBeGreaterThanOrEqual(1);
    await service.whenProcessed(id);
    const rec = service.get(id)!;
    expect(rec.status).toBe("ready");
    expect(rec.derived.text).toBe("texto pendiente");
  });
});

// ── Processing ────────────────────────────────────────────

describe("document processing", () => {
  it("extracts text and page count from a pdf", async () => {
    const meta = await uploadReady(makePdf("Informe trimestral", 3), "informe.pdf");
    expect(meta.status).toBe("ready");
    expect(meta.mime).toBe("application/pdf");
    expect(meta.derived.pages).toBe(3);
    expect(meta.derived.text).toContain("Informe trimestral 2");
    const file = await fetch(`${base}/api/attachments/${meta.id}/file`);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toStartWith("inline;");
  });

  it("extracts raw text from a docx", async () => {
    const meta = await uploadReady(await makeDocx("Contrato de alquiler"), "contrato.docx");
    expect(meta.status).toBe("ready");
    expect(meta.derived.text).toBe("Contrato de alquiler");
  });

  it("fails a pdf that cannot be parsed", async () => {
    const meta = await uploadReady(Buffer.from("%PDF-1.4\nesto no es un pdf\n"), "roto.pdf");
    expect(meta.status).toBe("failed");
    expect(meta.error).toContain("no se pudo leer");
  });

  it("truncates long text with a marker", async () => {
    settings["attachments.max_document_mb"] = "1";
    try {
      const meta = await uploadReady("ab".repeat(TEXT_CAP), "largo.md");
      expect(meta.derived.text!.length).toBeLessThan(TEXT_CAP + 100);
      expect(meta.derived.text).toContain("[…truncado, 200000 caracteres en total]");
    } finally {
      delete settings["attachments.max_document_mb"];
    }
  });
});

describe.skipIf(!HAS_FFMPEG)("image and video processing (ffmpeg)", () => {
  it("normalizes an image, reads its size and describes it when a model is set", async () => {
    settings["attachments.describe_model"] = "vision-test";
    try {
      const meta = await uploadReady(PNG_1PX, "pixel.png");
      expect(meta.kind).toBe("image");
      expect(meta.status).toBe("ready");
      expect(meta.derived.width).toBe(1);
      expect(meta.derived.height).toBe(1);
      expect(meta.derived.normalized).toBe(`attachments/${meta.id}/normalized.png`);

      // Description lands after `ready`.
      for (let i = 0; i < 50 && !service.get(meta.id)!.derived.description; i++) await new Promise((r) => setTimeout(r, 20));
      expect(service.get(meta.id)!.derived.description).toBe("una imagen de prueba");
      expect(described.at(-1)).toBe("vision-test:image/png:true");

      const thumb = await fetch(`${base}/api/attachments/${meta.id}/file?variant=normalized`);
      expect(thumb.status).toBe(200);
      expect(thumb.headers.get("content-type")).toBe("image/png");
      const original = await fetch(`${base}/api/attachments/${meta.id}/file`);
      expect(original.headers.get("content-disposition")).toStartWith("inline;");
      expect(Buffer.from(await original.arrayBuffer()).equals(PNG_1PX)).toBe(true);
    } finally {
      delete settings["attachments.describe_model"];
    }
  });

  it("strips metadata and fits a large jpeg inside 2048 px", async () => {
    const src = join(work, "big.jpg");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=3000x1000:rate=1", "-frames:v", "1", "-metadata", "comment=secreto", src]);
    const meta = await uploadReady(readFileSync(src), "grande.jpg");
    expect(meta.derived.width).toBe(3000);
    const out = join(dataDir, meta.derived.normalized!);
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height:format_tags", "-of", "json", out]).toString();
    const json = JSON.parse(probe) as { streams: Array<{ width: number; height: number }>; format?: { tags?: Record<string, string> } };
    expect(json.streams[0].width).toBe(2048);
    expect(json.streams[0].height).toBeLessThanOrEqual(683);
    expect(JSON.stringify(json.format?.tags ?? {})).not.toContain("secreto");
  });

  it("turns a 2 s video into frames, duration and a transcript warning without a model", async () => {
    const src = join(work, "clip.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
    ]);
    const meta = await uploadReady(readFileSync(src), "clip.mp4");
    expect(meta.kind).toBe("video");
    expect(meta.mime).toBe("video/mp4");
    expect(meta.status).toBe("ready");
    expect(meta.derived.duration_s).toBeGreaterThan(1.5);
    expect(meta.derived.duration_s).toBeLessThan(2.5);
    expect(meta.derived.width).toBe(320);
    expect(meta.derived.frames!.length).toBeGreaterThanOrEqual(8);
    expect(meta.derived.frames!.length).toBeLessThanOrEqual(16);
    // whisper missing or no model on disk — either way a warning, never a failure.
    expect(meta.derived.transcript ?? "").toBe("");
    expect((meta.derived.warnings ?? []).join(" ")).toMatch(/whisper|transcri/);

    const frame = await fetch(`${base}/api/attachments/${meta.id}/frames/0`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    expect((await fetch(`${base}/api/attachments/${meta.id}/frames/99`)).status).toBe(404);
    expect((await fetch(`${base}/api/attachments/${meta.id}/frames/x`)).status).toBe(400);

    // Range requests, for <video> seeking.
    const part = await fetch(`${base}/api/attachments/${meta.id}/file`, { headers: { Range: "bytes=0-99" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toStartWith("bytes 0-99/");
    expect((await part.arrayBuffer()).byteLength).toBe(100);
  }, 120_000);

  it("fails a video longer than the limit", async () => {
    settings["attachments.max_video_seconds"] = "1";
    try {
      const src = join(work, "long.webm");
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=3",
        "-c:v", "libvpx", "-b:v", "100k", src,
      ]);
      const meta = await uploadReady(readFileSync(src), "largo.webm");
      expect(meta.mime).toBe("video/webm");
      expect(meta.status).toBe("failed");
      expect(meta.error).toContain("el máximo es 1 s");
    } finally {
      delete settings["attachments.max_video_seconds"];
    }
  }, 60_000);
});

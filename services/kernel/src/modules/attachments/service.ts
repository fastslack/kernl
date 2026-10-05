/**
 * Chat attachments: the store, the upload stream and the processing queue.
 *
 * Files live under `<data>/attachments/<id>/` and are only ever found by id:
 * the id is a uuid v4 we generated, the stored name is `original.<ext>` with
 * the extension we detected, and the sender's filename is kept for display and
 * nothing else. `absPath()` refuses anything that resolves outside the
 * attachments dir, so even a corrupted row cannot point at another file.
 *
 * Lifecycle: upload → `processing` → `ready` | `failed`. Sending a message
 * binds the ids (`bound_at`); anything still unbound a day later was abandoned
 * in a composer and the hourly sweep removes it.
 */

import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../../core/http-server.js";
import { isoNow, newId } from "../../core/helpers.js";
import { isPathInside } from "../../core/fs-paths.js";
import { log } from "../../core/logger.js";
import { llm } from "../../core/llm/client.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { VoiceSettings } from "../../voice/types.js";
import { voiceSettingsFromEnv } from "../../voice/settings.js";
import { DETECT_HEAD_BYTES, detectType, displayFilename, isCleanUtf8, type DetectedType } from "./detect.js";
import { processAttachment, ProcessingFailure } from "./processor.js";
import type { AttachmentDerived, AttachmentKind, AttachmentMeta, AttachmentRecord, AttachmentStatus } from "./types.js";

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Unbound attachments older than this are swept. */
export const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAttachmentId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/** Default caps; each can be overridden with `attachments.max_<kind>_mb`. */
const DEFAULT_CAP_MB: Record<AttachmentKind, number> = { image: 20, document: 30, video: 100 };
const DEFAULT_MAX_VIDEO_SECONDS = 180;
/** Per lane: video is one ffmpeg + whisper at a time, the rest are cheap. */
const CONCURRENCY = { video: 1, other: 3 } as const;
/** Images larger than this are not sent for a description. */
const DESCRIBE_MAX_BYTES = 5 * 1024 * 1024;

export interface AttachmentLimits {
  bytes: Record<AttachmentKind, number>;
  videoSeconds: number;
}

/** Describe an image in a sentence or two; null when there is nothing to say. */
export type ImageDescriber = (image: Buffer, mime: string, model: string) => Promise<string | null>;

export interface AttachmentServiceOptions {
  /** Root of the kernel's data; defaults to `<cwd>/data`, like the rest of the kernel. */
  dataDir?: string;
  /** Settings lookup. Defaults to `app_settings`, then the env var (`attachments.x_y` → `ATTACHMENTS_X_Y`). */
  setting?: (key: string) => string | undefined;
  /** Voice settings, for the whisper model and language. */
  voice?: () => VoiceSettings;
  /** Image description; defaults to the LLM driver with the `attachments.describe_model` model. */
  describeImage?: ImageDescriber;
}

interface Row {
  id: string;
  kind: AttachmentKind;
  mime: string;
  filename: string;
  size_bytes: number;
  path: string;
  status: AttachmentStatus;
  derived: string;
  error: string | null;
  bound_at: string | null;
  created_at: string;
}

function toRecord(row: Row): AttachmentRecord {
  let derived: AttachmentDerived = {};
  try {
    const parsed = JSON.parse(row.derived || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) derived = parsed as AttachmentDerived;
  } catch { /* a broken blob reads as "nothing derived" */ }
  return { ...row, derived };
}

const defaultDescriber: ImageDescriber = async (image, mime, model) => {
  const res = await llm().chat({
    model,
    user: "Describí esta imagen en una o dos oraciones, en español, para alguien que no puede verla. Si tiene texto legible, transcribilo.",
    imageBase64: image.toString("base64"),
    imageMediaType: mime,
    maxTokens: 300,
    caller: "attachments:describe",
  });
  const text = res.text.trim();
  return text ? text.slice(0, 1000) : null;
};

interface Lane {
  limit: number;
  active: number;
  queue: string[];
}

async function writeChunk(out: WriteStream, chunk: Buffer): Promise<void> {
  if (out.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => { out.off("error", onError); resolve(); };
    const onError = (err: Error) => { out.off("drain", onDrain); reject(err); };
    out.once("drain", onDrain);
    out.once("error", onError);
  });
}

function closeStream(out: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    out.once("error", reject);
    out.once("finish", () => resolve());
    out.end();
  });
}

const tooLarge = (kind: AttachmentKind | null, limit: number) =>
  new HttpError(413, `El archivo supera el máximo${kind ? ` para ${kind === "image" ? "imágenes" : kind === "video" ? "videos" : "documentos"}` : ""} (${Math.round(limit / 1024 / 1024)} MB)`);

const unsupported = () =>
  new HttpError(415, "Tipo de archivo no admitido. Se aceptan imágenes (jpeg, png, gif, webp), documentos (pdf, docx, txt, md, csv, json) y videos (mp4, mov, webm).");

export class AttachmentService {
  readonly dataDir: string;
  private readonly root: string;
  private readonly settingFn: (key: string) => string | undefined;
  private readonly voice: () => VoiceSettings;
  private readonly describeImage: ImageDescriber;
  private readonly lanes: Record<"video" | "other", Lane> = {
    video: { limit: CONCURRENCY.video, active: 0, queue: [] },
    other: { limit: CONCURRENCY.other, active: 0, queue: [] },
  };
  private readonly pending = new Map<string, Array<() => void>>();
  private stopped = false;

  constructor(private readonly db: SqliteDb, opts: AttachmentServiceOptions = {}) {
    this.dataDir = path.resolve(opts.dataDir ?? path.join(process.cwd(), "data"));
    this.root = path.join(this.dataDir, "attachments");
    this.settingFn = opts.setting ?? ((key) => this.storedSetting(key));
    const envVoice = voiceSettingsFromEnv(process.env);
    this.voice = opts.voice ?? (() => envVoice);
    this.describeImage = opts.describeImage ?? defaultDescriber;
  }

  // ── Paths and settings ─────────────────────────────────

  /** Data-dir-relative path → absolute. Throws for anything outside `<data>/attachments`. */
  absPath(rel: string): string {
    const abs = path.resolve(this.dataDir, rel);
    if (!isPathInside(this.root, abs, { allowRoot: false })) throw new Error(`attachment path outside the attachments dir: ${rel}`);
    return abs;
  }

  private storedSetting(key: string): string | undefined {
    try {
      const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value?: string } | undefined;
      if (row?.value) return row.value;
    } catch { /* no app_settings table (tests, early boot) */ }
    return process.env[key.toUpperCase().replace(/\./g, "_")];
  }

  setting(key: string): string | undefined {
    const v = this.settingFn(key);
    return v === undefined || v === null ? undefined : String(v);
  }

  limits(): AttachmentLimits {
    const num = (key: string, fallback: number) => {
      const n = Number.parseFloat(this.setting(key) ?? "");
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const bytes = {} as Record<AttachmentKind, number>;
    for (const kind of Object.keys(DEFAULT_CAP_MB) as AttachmentKind[]) {
      bytes[kind] = Math.floor(num(`attachments.max_${kind}_mb`, DEFAULT_CAP_MB[kind]) * 1024 * 1024);
    }
    return { bytes, videoSeconds: num("attachments.max_video_seconds", DEFAULT_MAX_VIDEO_SECONDS) };
  }

  // ── Upload ─────────────────────────────────────────────

  /**
   * Stream an upload to disk. The type is decided from the first bytes, and
   * the cap for that type is enforced chunk by chunk, so an oversized file is
   * refused as soon as it crosses the line rather than after it has landed.
   * Throws `HttpError` 400 / 413 / 415; nothing is left on disk when it does.
   */
  async createFromStream(source: AsyncIterable<Buffer | Uint8Array>, filename: string, declaredLength?: number): Promise<AttachmentRecord> {
    const limits = this.limits();
    const maxAny = Math.max(...Object.values(limits.bytes));
    if (declaredLength !== undefined && declaredLength > maxAny) throw tooLarge(null, maxAny);

    const id = newId();
    const relDir = `attachments/${id}`;
    const dir = this.absPath(relDir);
    await mkdir(dir, { recursive: true });
    const partPath = path.join(dir, "upload.part");
    const out = createWriteStream(partPath, { flags: "wx" });
    // Always listening: a write error (ENOSPC on a big video) emitted between
    // writes would otherwise be an uncaught exception, and a drain or finish
    // that never comes would hang the request. Checked before every write.
    let streamError: Error | null = null;
    out.on("error", (err) => { streamError = err; });
    const healthy = () => { if (streamError) throw streamError; };

    let head: Buffer[] = [];
    let headLength = 0;
    let detected: DetectedType | null = null;
    let limit = maxAny;
    let total = 0;

    const decide = async () => {
      const buf = Buffer.concat(head);
      detected = detectType(buf, filename);
      if (!detected) throw unsupported();
      limit = limits.bytes[detected.kind];
      if (total > limit) throw tooLarge(detected.kind, limit);
      healthy();
      await writeChunk(out, buf);
      head = [];
    };

    try {
      for await (const raw of source) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        total += chunk.length;
        if (!detected) {
          if (total > limit) throw tooLarge(null, limit);
          head.push(chunk);
          headLength += chunk.length;
          if (headLength >= DETECT_HEAD_BYTES) await decide();
          continue;
        }
        if (total > limit) throw tooLarge((detected as DetectedType).kind, limit);
        healthy();
        await writeChunk(out, chunk);
      }
      if (total === 0) throw new HttpError(400, "El archivo está vacío");
      if (!detected) await decide();
      healthy();
      await closeStream(out);

      const type = detected as unknown as DetectedType;
      if (type.text && !isCleanUtf8(await readFile(partPath))) throw unsupported();

      const rel = `${relDir}/original.${type.ext}`;
      await rename(partPath, this.absPath(rel));
      this.db.prepare(
        `INSERT INTO attachments (id, kind, mime, filename, size_bytes, path, status, derived, error, bound_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'processing', '{}', NULL, NULL, ?)`,
      ).run(id, type.kind, type.mime, displayFilename(filename, type.ext), total, rel, isoNow());
    } catch (err) {
      out.destroy();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    this.enqueue(id, (detected as unknown as DetectedType).kind);
    return this.get(id)!;
  }

  // ── Reads ──────────────────────────────────────────────

  get(id: string): AttachmentRecord | null {
    if (!isAttachmentId(id)) return null;
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** Records for `ids`, in that order; unknown ids are skipped. */
  getRecords(ids: readonly string[]): AttachmentRecord[] {
    const out: AttachmentRecord[] = [];
    for (const id of ids) {
      const rec = this.get(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  toMeta(rec: AttachmentRecord): AttachmentMeta {
    return {
      id: rec.id,
      kind: rec.kind,
      mime: rec.mime,
      filename: rec.filename,
      size_bytes: rec.size_bytes,
      status: rec.status,
      error: rec.error,
      derived: rec.derived,
      created_at: rec.created_at,
    };
  }

  // ── Binding and deletion ───────────────────────────────

  /**
   * Bind the attachments a message is about to reference. All-or-nothing:
   * an unknown, still-processing or failed id (or more than 10) throws
   * `HttpError(400)` and binds none. Returns the records, in the given order,
   * duplicates dropped. Binding an already-bound id is fine (a resend).
   */
  bind(ids: readonly string[]): AttachmentRecord[] {
    const unique = [...new Set(ids)];
    if (unique.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new HttpError(400, `Se admiten hasta ${MAX_ATTACHMENTS_PER_MESSAGE} adjuntos por mensaje`);
    }
    const records: AttachmentRecord[] = [];
    for (const id of unique) {
      const rec = this.get(id);
      if (!rec) throw new HttpError(400, `Adjunto desconocido: ${String(id).slice(0, 64)}`);
      if (rec.status === "processing") throw new HttpError(400, `El adjunto ${rec.filename} todavía se está procesando`);
      if (rec.status === "failed") throw new HttpError(400, `El adjunto ${rec.filename} no se pudo procesar: ${rec.error ?? "error"}`);
      records.push(rec);
    }
    if (records.length === 0) return [];
    const now = isoNow();
    const stmt = this.db.prepare("UPDATE attachments SET bound_at = COALESCE(bound_at, ?) WHERE id = ?");
    this.db.transaction(() => { for (const r of records) stmt.run(now, r.id); })();
    return records.map((r) => ({ ...r, bound_at: r.bound_at ?? now }));
  }

  /** Composer cancel: delete only while nothing references it. */
  async deleteIfUnbound(id: string): Promise<"deleted" | "not_found" | "bound"> {
    const rec = this.get(id);
    if (!rec) return "not_found";
    if (rec.bound_at) return "bound";
    const r = this.db.prepare("DELETE FROM attachments WHERE id = ? AND bound_at IS NULL").run(id);
    if (r.changes === 0) return "bound";
    await this.removeDir(id);
    return "deleted";
  }

  /** Delete regardless of binding — for when the messages that referenced them are gone (episode deletion). */
  async deleteMany(ids: readonly string[]): Promise<number> {
    let n = 0;
    for (const id of new Set(ids)) {
      if (!isAttachmentId(id)) continue;
      const r = this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
      n += r.changes;
      await this.removeDir(id);
    }
    return n;
  }

  private async removeDir(id: string): Promise<void> {
    if (!isAttachmentId(id)) return;
    await rm(this.absPath(`attachments/${id}`), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((err) => {
      log.warn(`attachments: could not remove ${id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Remove unbound attachments older than `maxAgeMs`, and directories with no
   * row at all (an upload interrupted by a restart). Returns rows removed.
   */
  async sweepOrphans(maxAgeMs = ORPHAN_MAX_AGE_MS, now = Date.now()): Promise<number> {
    const cutoff = new Date(now - maxAgeMs).toISOString();
    const rows = this.db.prepare("SELECT id FROM attachments WHERE bound_at IS NULL AND created_at < ?").all(cutoff) as Array<{ id: string }>;
    for (const { id } of rows) {
      this.db.prepare("DELETE FROM attachments WHERE id = ? AND bound_at IS NULL").run(id);
      await this.removeDir(id);
    }
    if (existsSync(this.root)) {
      for (const name of await readdir(this.root).catch(() => [] as string[])) {
        if (!isAttachmentId(name) || this.get(name)) continue;
        const st = await stat(path.join(this.root, name)).catch(() => null);
        if (st && st.mtimeMs < now - maxAgeMs) await this.removeDir(name);
      }
    }
    if (rows.length) log.info(`attachments: swept ${rows.length} unbound attachment(s)`);
    return rows.length;
  }

  // ── Processing queue ───────────────────────────────────

  /** Rows a restart left `processing` go back in the queue. */
  requeuePending(): number {
    const rows = this.db.prepare("SELECT id, kind FROM attachments WHERE status = 'processing' ORDER BY created_at").all() as Array<{ id: string; kind: AttachmentKind }>;
    for (const r of rows) this.enqueue(r.id, r.kind);
    return rows.length;
  }

  /** Resolves once `id` has left the queue (immediately when it is not in it). */
  whenProcessed(id: string): Promise<void> {
    const waiters = this.pending.get(id);
    if (!waiters) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
  }

  /** Stop taking work; what is running finishes on its own. */
  stop(): void {
    this.stopped = true;
    this.lanes.video.queue.length = 0;
    this.lanes.other.queue.length = 0;
  }

  private enqueue(id: string, kind: AttachmentKind): void {
    if (this.stopped || this.pending.has(id)) return;
    this.pending.set(id, []);
    const lane = kind === "video" ? this.lanes.video : this.lanes.other;
    lane.queue.push(id);
    this.pump(lane);
  }

  private pump(lane: Lane): void {
    while (!this.stopped && lane.active < lane.limit && lane.queue.length > 0) {
      const id = lane.queue.shift()!;
      lane.active++;
      this.processOne(id)
        .catch((err) => log.error(`attachments: processing ${id} crashed`, err))
        .finally(() => {
          lane.active--;
          const waiters = this.pending.get(id) ?? [];
          this.pending.delete(id);
          for (const w of waiters) w();
          this.pump(lane);
        });
    }
  }

  private async processOne(id: string): Promise<void> {
    const rec = this.get(id);
    if (!rec || rec.status !== "processing") return;
    const limits = this.limits();
    const ctx = {
      absPath: (rel: string) => this.absPath(rel),
      relDir: `attachments/${id}`,
      voice: this.voice,
      maxVideoSeconds: limits.videoSeconds,
    };
    try {
      const derived = await processAttachment(rec, ctx);
      this.db.prepare("UPDATE attachments SET status = 'ready', derived = ?, error = NULL WHERE id = ?").run(JSON.stringify(derived), id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const derived = err instanceof ProcessingFailure ? err.derived : {};
      if (!(err instanceof ProcessingFailure)) log.warn(`attachments: ${id} failed unexpectedly: ${msg}`);
      this.db.prepare("UPDATE attachments SET status = 'failed', derived = ?, error = ? WHERE id = ?").run(JSON.stringify(derived), msg.slice(0, 500), id);
      return;
    }
    // After `ready`, never before: a description is a nicety the message
    // must not wait for.
    if (rec.kind === "image") void this.describe(id);
  }

  /** Optional vision description; only when `attachments.describe_model` names a model. */
  private async describe(id: string): Promise<void> {
    const model = this.setting("attachments.describe_model")?.trim();
    if (!model) return;
    const rec = this.get(id);
    if (!rec) return;
    const rel = rec.derived.normalized ?? rec.path;
    const mime = rel.endsWith(".jpg") ? "image/jpeg" : rel.endsWith(".png") ? "image/png" : rec.mime;
    try {
      const image = await readFile(this.absPath(rel));
      if (image.length > DESCRIBE_MAX_BYTES) return;
      const description = await this.describeImage(image, mime, model);
      if (!description) return;
      const current = this.get(id);
      if (!current) return;
      const derived = { ...current.derived, description };
      this.db.prepare("UPDATE attachments SET derived = ? WHERE id = ?").run(JSON.stringify(derived), id);
    } catch (err) {
      log.warn(`attachments: describing ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

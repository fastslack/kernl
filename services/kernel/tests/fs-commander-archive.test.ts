import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import archiver from "archiver";
import { createWriteStream } from "node:fs";
import type { SqliteDb } from "../src/core/db/sqlite.js";
import type { KernelConfig } from "../src/core/config.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { fsCommanderMigrations } from "../assets/extensions/productivity/filesystem-commander/_module/migrations.js";
import { FsCommanderService } from "../assets/extensions/productivity/filesystem-commander/_module/service.js";

function mkConfig(allowedRoots: string[]): KernelConfig {
  return {
    fsCommander: {
      allowedRoots,
      maxPreviewBytes: 2_097_152,
      maxEditorBytes: 4_194_304,
      encryptionKey: "",
    },
  } as unknown as KernelConfig;
}

function mkDb(): SqliteDb {
  const db = new Database(":memory:");
  runMigrations(db, "filesystem-commander", fsCommanderMigrations);
  return db;
}

async function makeZip(
  outPath: string,
  entries: Array<{ name: string; content: string }>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outPath);
    const archive = archiver("zip");
    out.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(out);
    for (const e of entries) archive.append(e.content, { name: e.name });
    archive.finalize();
  });
}

describe("ArchiveProvider (zip)", () => {
  let sandbox: string;
  let svc: FsCommanderService;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "fs-archive-test-"));
    svc = new FsCommanderService(mkDb(), mkConfig([sandbox]));
  });
  afterEach(async () => {
    await svc.shutdown();
    await rm(sandbox, { recursive: true, force: true });
  });

  it("opens a zip and lists entries", async () => {
    const zipPath = join(sandbox, "demo.zip");
    await makeZip(zipPath, [
      { name: "readme.md", content: "hello" },
      { name: "src/main.js", content: "console.log(1)" },
      { name: "src/util.js", content: "export const x = 42" },
    ]);

    const info = await svc.openArchive("local", zipPath);
    expect(info.id).toMatch(/^archive:/);

    const provider = svc.get(info.id);
    const root = await provider.list("");
    const names = root.entries.map((e) => e.name).sort();
    expect(names).toContain("readme.md");
    expect(names).toContain("src");

    const src = await provider.list("src");
    const srcNames = src.entries.map((e) => e.name).sort();
    expect(srcNames).toEqual(["main.js", "util.js"]);
  });

  it("reads file contents via readStream", async () => {
    const zipPath = join(sandbox, "demo2.zip");
    const payload = "content-inside-zip-" + "x".repeat(100);
    await makeZip(zipPath, [{ name: "deep/nested/file.txt", content: payload }]);
    const info = await svc.openArchive("local", zipPath);
    const provider = svc.get(info.id);

    const stream = await provider.readStream("deep/nested/file.txt");
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
    expect(Buffer.concat(chunks).toString("utf-8")).toBe(payload);
  });

  it("rejects paths not in the archive", async () => {
    const zipPath = join(sandbox, "demo3.zip");
    await makeZip(zipPath, [{ name: "a.txt", content: "a" }]);
    const info = await svc.openArchive("local", zipPath);
    const provider = svc.get(info.id);
    await expect(provider.stat("nope.txt")).rejects.toThrow();
  });

  it("closeArchive unregisters the provider", async () => {
    const zipPath = join(sandbox, "demo4.zip");
    await makeZip(zipPath, [{ name: "f.txt", content: "f" }]);
    const info = await svc.openArchive("local", zipPath);
    expect(svc.listProviders().some((p) => p.id === info.id)).toBe(true);
    await svc.closeArchive(info.id);
    expect(svc.listProviders().some((p) => p.id === info.id)).toBe(false);
  });

  it("refuses to open archive from non-local provider", async () => {
    // Register a fake sftp-like provider so the "Unknown provider" guard
    // doesn't fire first — we're checking the kind-filter downstream.
    const stub = {
      id: "sftp:fake",
      kind: "sftp" as const,
      label: "fake",
      list: async () => ({ path: "/", entries: [], parent: null }),
      stat: async () => ({
        path: "/",
        name: "",
        kind: "file" as const,
        size: 0,
        mtime: new Date().toISOString(),
      }),
      readStream: async () => {
        throw new Error("not implemented");
      },
      writeStream: async () => {
        throw new Error("not implemented");
      },
      mkdir: async () => {},
      rm: async () => {},
      rename: async () => {},
    };
    svc.register(stub as unknown as Parameters<typeof svc.register>[0]);
    await expect(svc.openArchive("sftp:fake", "/nope.zip")).rejects.toThrow(
      /not yet supported/,
    );
  });
});

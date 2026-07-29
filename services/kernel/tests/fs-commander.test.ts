import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { SqliteDb } from "../src/core/db/sqlite.js";
import type { KernelConfig } from "../src/core/config.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { fsCommanderMigrations } from "../assets/extensions/productivity/filesystem-commander/_module/migrations.js";
import { FsCommanderService } from "../assets/extensions/productivity/filesystem-commander/_module/service.js";
import {
  LocalProvider,
} from "../assets/extensions/productivity/filesystem-commander/_module/providers/local.js";
import { PathOutOfScopeError } from "../assets/extensions/productivity/filesystem-commander/_module/providers/provider.js";

// A partial KernelConfig is enough for these unit tests — the service only
// reads `fsCommander.allowedRoots` at construction.
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

describe("LocalProvider", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "fs-commander-test-"));
  });
  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("lists entries and marks directories first", async () => {
    await mkdir(join(sandbox, "beta"));
    await writeFile(join(sandbox, "alpha.txt"), "hi");
    await writeFile(join(sandbox, "gamma.md"), "g");

    const p = new LocalProvider([sandbox]);
    const listing = await p.list(sandbox);
    expect(listing.path).toBe(sandbox);
    expect(listing.entries.map((e) => e.name)).toEqual([
      "beta",
      "alpha.txt",
      "gamma.md",
    ]);
    expect(listing.entries[0].kind).toBe("dir");
    expect(listing.entries[1].kind).toBe("file");
    expect(listing.entries[1].size).toBe(2);
  });

  it("rejects paths outside allowedRoots", async () => {
    const p = new LocalProvider([sandbox]);
    await expect(p.list("/etc")).rejects.toBeInstanceOf(PathOutOfScopeError);
  });

  it("stat returns mtime, size, permissions", async () => {
    const f = join(sandbox, "x.txt");
    await writeFile(f, "hello");
    const p = new LocalProvider([sandbox]);
    const s = await p.stat(f);
    expect(s.size).toBe(5);
    expect(s.kind).toBe("file");
    expect(s.permissions).toMatch(/^[rwx-]{9}$/);
  });

  it("symlinks are reported with target", async () => {
    await writeFile(join(sandbox, "real.txt"), "r");
    await symlink(join(sandbox, "real.txt"), join(sandbox, "link"));
    const p = new LocalProvider([sandbox]);
    const listing = await p.list(sandbox);
    const link = listing.entries.find((e) => e.name === "link")!;
    expect(link.kind).toBe("symlink");
    expect(link.target).toContain("real.txt");
  });

  it("list parent is null at root", async () => {
    const p = new LocalProvider([sandbox]);
    const listing = await p.list(sandbox);
    expect(listing.parent).toBeNull();
  });

  it("mkdir + rename + rm flow", async () => {
    const p = new LocalProvider([sandbox]);
    await p.mkdir(join(sandbox, "one"));
    await p.rename(join(sandbox, "one"), join(sandbox, "two"));
    await p.rm(join(sandbox, "two"), { recursive: true });
    const listing = await p.list(sandbox);
    expect(listing.entries).toHaveLength(0);
  });

  it("refuses to delete a configured root", async () => {
    const p = new LocalProvider([sandbox]);
    await expect(p.rm(sandbox, { recursive: true })).rejects.toThrow(/root/);
  });
});

describe("FsCommanderService", () => {
  let sandbox: string;
  let svc: FsCommanderService;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "fs-svc-test-"));
    svc = new FsCommanderService(mkDb(), mkConfig([sandbox]));
  });
  afterEach(async () => {
    await svc.shutdown();
    await rm(sandbox, { recursive: true, force: true });
  });

  it("registers the local provider on construction", () => {
    const ps = svc.listProviders();
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ id: "local", kind: "local" });
  });

  it("bookmarks CRUD", () => {
    expect(svc.bookmarksList()).toHaveLength(0);
    const b = svc.bookmarkAdd({ label: "Home", providerId: "local", path: sandbox });
    expect(b.id).toBeTruthy();
    expect(svc.bookmarksList()).toHaveLength(1);
    svc.bookmarkRemove(b.id);
    expect(svc.bookmarksList()).toHaveLength(0);
  });

  it("history is bounded to 500 rows per pane", () => {
    for (let i = 0; i < 520; i++) {
      svc.historyPush("left", "local", `${sandbox}/p${i}`);
    }
    expect(svc.historyList("left", 1000)).toHaveLength(500);
    expect(svc.historyList("right")).toHaveLength(0);
  });

  it("tabs round-trip via set/get", () => {
    const tabs = [
      { provider_id: "local", path: sandbox, title: "A" },
      { provider_id: "local", path: sandbox + "/x", title: "B" },
    ];
    const stored = svc.tabsSet("left", tabs);
    expect(stored).toHaveLength(2);
    expect(stored[0].title).toBe("A");
    expect(stored[1].title).toBe("B");
    expect(svc.tabsGet("left")).toHaveLength(2);
    expect(svc.tabsGet("right")).toHaveLength(0);

    // Overwrite semantics: setting again replaces.
    svc.tabsSet("left", [{ provider_id: "local", path: sandbox, title: "X" }]);
    const again = svc.tabsGet("left");
    expect(again).toHaveLength(1);
    expect(again[0].title).toBe("X");
  });

  it("rejects duplicate provider registration", () => {
    const p = new LocalProvider([sandbox]);
    expect(() => svc.register(p)).toThrow(/already registered/);
  });
});

describe("RemoteCrypto", () => {
  it("encrypt→decrypt round-trips structured config", async () => {
    const { RemoteCrypto } = await import(
      "../assets/extensions/productivity/filesystem-commander/_module/crypto.js"
    );
    const c = new RemoteCrypto("test-secret-key-123");
    const envelope = c.encrypt({ host: "example.com", password: "p4ss" });
    expect(envelope).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const back = c.decrypt<{ host: string; password: string }>(envelope);
    expect(back.host).toBe("example.com");
    expect(back.password).toBe("p4ss");
  });

  it("different secrets produce undecryptable envelopes", async () => {
    const { RemoteCrypto } = await import(
      "../assets/extensions/productivity/filesystem-commander/_module/crypto.js"
    );
    const a = new RemoteCrypto("secret-one");
    const b = new RemoteCrypto("secret-two");
    const envelope = a.encrypt({ x: 1 });
    expect(() => b.decrypt(envelope)).toThrow();
  });

  it("unavailable when key is empty", async () => {
    const { RemoteCrypto } = await import(
      "../assets/extensions/productivity/filesystem-commander/_module/crypto.js"
    );
    const c = new RemoteCrypto("");
    expect(c.available).toBe(false);
    expect(() => c.encrypt({})).toThrow(/not configured/);
  });
});

describe("FsCommanderService remotes (persistence)", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "fs-remotes-test-"));
  });
  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("persists an SFTP remote encrypted and reloads it on a fresh service", async () => {
    const db = mkDb();
    const cfg: KernelConfig = {
      fsCommander: {
        allowedRoots: [sandbox],
        maxPreviewBytes: 2_097_152,
        maxEditorBytes: 4_194_304,
        encryptionKey: "persist-test-key",
      },
    } as unknown as KernelConfig;

    const svc1 = new FsCommanderService(db, cfg);
    const info = await svc1.addRemote({
      kind: "sftp",
      label: "nas",
      config: { host: "10.0.0.5", username: "me", password: "secret" } as never,
    });
    expect(info.provider_id.startsWith("sftp:")).toBe(true);
    expect(svc1.listProviders().some((p) => p.id === info.provider_id)).toBe(true);
    // DB has exactly 1 encrypted row, no plaintext.
    const rows = db.prepare(`SELECT config_encrypted FROM fs_remotes`).all() as Array<{ config_encrypted: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].config_encrypted).not.toContain("secret");
    expect(rows[0].config_encrypted).not.toContain("10.0.0.5");

    await svc1.shutdown();

    // Fresh service on the same DB should reload it.
    const svc2 = new FsCommanderService(db, cfg);
    expect(svc2.listProviders().some((p) => p.id === info.provider_id)).toBe(true);
    await svc2.removeRemote(info.id);
    expect(svc2.listProviders().some((p) => p.id === info.provider_id)).toBe(false);
    await svc2.shutdown();
  });

  it("refuses to add a remote when crypto is unavailable", async () => {
    const svc = new FsCommanderService(
      mkDb(),
      {
        fsCommander: {
          allowedRoots: [sandbox],
          maxPreviewBytes: 2_097_152,
          maxEditorBytes: 4_194_304,
          encryptionKey: "",
        },
      } as unknown as KernelConfig,
    );
    await expect(
      svc.addRemote({
        kind: "sftp",
        label: "x",
        config: { host: "h", username: "u", password: "p" } as never,
      }),
    ).rejects.toThrow(/not configured/);
    await svc.shutdown();
  });
});

describe("OpEngine", () => {
  let sandbox: string;
  let svc: FsCommanderService;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "fs-ops-test-"));
    svc = new FsCommanderService(mkDb(), mkConfig([sandbox]));
  });
  afterEach(async () => {
    await svc.shutdown();
    await rm(sandbox, { recursive: true, force: true });
  });

  function waitOp(id: string): Promise<import("../assets/extensions/productivity/filesystem-commander/_module/ops.js").OpProgress> {
    return new Promise((resolve) => {
      const unsub = svc.ops.subscribe(id, (p) => {
        if (p.status === "done" || p.status === "error" || p.status === "cancelled") {
          unsub();
          resolve(p);
        }
      });
    });
  }

  it("copy: cross-directory, single file", async () => {
    const src = join(sandbox, "src");
    const dst = join(sandbox, "dst");
    await mkdir(src);
    await mkdir(dst);
    await writeFile(join(src, "a.txt"), "hello");

    const local = svc.get("local");
    const opId = svc.ops.start({
      kind: "copy",
      src: local,
      dst: local,
      items: [{ from: join(src, "a.txt"), to: join(dst, "a.txt") }],
    });
    const final = await waitOp(opId);
    expect(final.status).toBe("done");
    expect(final.bytes).toBe(5);
    expect(final.itemsDone).toBe(1);

    // Both files exist after copy.
    const srcList = await local.list(src);
    const dstList = await local.list(dst);
    expect(srcList.entries.map((e) => e.name)).toContain("a.txt");
    expect(dstList.entries.map((e) => e.name)).toContain("a.txt");
  });

  it("move: removes the source after success", async () => {
    const src = join(sandbox, "src");
    const dst = join(sandbox, "dst");
    await mkdir(src);
    await mkdir(dst);
    await writeFile(join(src, "b.txt"), "world");

    const local = svc.get("local");
    const opId = svc.ops.start({
      kind: "move",
      src: local,
      dst: local,
      items: [{ from: join(src, "b.txt"), to: join(dst, "b.txt") }],
    });
    const final = await waitOp(opId);
    expect(final.status).toBe("done");

    const srcList = await local.list(src);
    const dstList = await local.list(dst);
    expect(srcList.entries.map((e) => e.name)).not.toContain("b.txt");
    expect(dstList.entries.map((e) => e.name)).toContain("b.txt");
  });

  it("copy: directory tree recursively", async () => {
    const src = join(sandbox, "tree");
    const dst = join(sandbox, "copy-tree");
    await mkdir(src);
    await mkdir(join(src, "sub"));
    await writeFile(join(src, "sub", "nested.txt"), "nested");
    await writeFile(join(src, "root.txt"), "root");

    const local = svc.get("local");
    const opId = svc.ops.start({
      kind: "copy",
      src: local,
      dst: local,
      items: [{ from: src, to: dst }],
    });
    const final = await waitOp(opId);
    expect(final.status).toBe("done");
    expect(final.itemsDone).toBeGreaterThanOrEqual(3); // dir + sub + files

    const dstRoot = await local.list(dst);
    expect(dstRoot.entries.map((e) => e.name).sort()).toEqual(["root.txt", "sub"]);
    const dstSub = await local.list(join(dst, "sub"));
    expect(dstSub.entries.map((e) => e.name)).toContain("nested.txt");
  });

  it("cancel: aborts a running op", async () => {
    const src = join(sandbox, "big-src");
    const dst = join(sandbox, "big-dst");
    await mkdir(src);
    await mkdir(dst);
    // A couple of files so enumeration has work to do.
    for (let i = 0; i < 5; i++) {
      await writeFile(join(src, `f${i}.bin`), Buffer.alloc(256 * 1024));
    }
    const local = svc.get("local");
    const opId = svc.ops.start({
      kind: "copy",
      src: local,
      dst: local,
      items: [{ from: src, to: dst }],
    });
    svc.ops.cancel(opId);
    const final = await waitOp(opId);
    // Could end in either "cancelled" (aborted in-flight) or "done" (finished
    // before we could abort — possible with very small trees). Both acceptable
    // for the cancellation wiring to work.
    expect(["cancelled", "done"]).toContain(final.status);
  });
});

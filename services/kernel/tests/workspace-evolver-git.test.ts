import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRepo,
  isInitialised,
  isDirty,
  snapshot,
  getHead,
  revertTo,
  listChangedFiles,
} from "../assets/extensions/agents/agent-advanced/_module/workspace-evolver/git-snapshot.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "evolver-git-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("git-snapshot", () => {
  it("ensureRepo creates a fresh repo when missing", async () => {
    expect(await isInitialised(workDir)).toBe(false);
    const head = await ensureRepo(workDir);
    expect(await isInitialised(workDir)).toBe(true);
    expect(head.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it("ensureRepo is idempotent", async () => {
    const first = await ensureRepo(workDir);
    const second = await ensureRepo(workDir);
    expect(first.ref).toEqual(second.ref);
  });

  it("snapshot commits dirty changes and advances HEAD", async () => {
    await ensureRepo(workDir);
    await writeFile(join(workDir, "a.txt"), "hello", "utf8");
    expect(await isDirty(workDir)).toBe(true);
    const before = await getHead(workDir);
    const after = await snapshot(workDir, "first change");
    expect(after.ref).not.toEqual(before.ref);
    expect(after.label).toBe("first change");
    expect(await isDirty(workDir)).toBe(false);
  });

  it("snapshot is a no-op on a clean tree", async () => {
    const before = await ensureRepo(workDir);
    const after = await snapshot(workDir, "no change");
    expect(after.ref).toEqual(before.ref);
  });

  it("revertTo discards uncommitted changes back to ref", async () => {
    const baseline = await ensureRepo(workDir);
    await writeFile(join(workDir, "a.txt"), "first", "utf8");
    const candidate = await snapshot(workDir, "candidate");
    expect(candidate.ref).not.toEqual(baseline.ref);

    await writeFile(join(workDir, "a.txt"), "dirty", "utf8");
    expect(await isDirty(workDir)).toBe(true);

    await revertTo(workDir, baseline.ref);
    expect((await getHead(workDir)).ref).toEqual(baseline.ref);
    // The file from candidate is gone too (hard reset).
    let exists = true;
    try { await readFile(join(workDir, "a.txt"), "utf8"); }
    catch { exists = false; }
    expect(exists).toBe(false);
  });

  it("revertTo refuses suspicious refs", async () => {
    await ensureRepo(workDir);
    await expect(revertTo(workDir, "../escape")).rejects.toThrow();
    await expect(revertTo(workDir, "")).rejects.toThrow();
  });

  it("listChangedFiles returns paths between two refs", async () => {
    const a = await ensureRepo(workDir);
    await writeFile(join(workDir, "x.txt"), "1", "utf8");
    await writeFile(join(workDir, "y.txt"), "2", "utf8");
    const b = await snapshot(workDir, "add x and y");
    const files = await listChangedFiles(workDir, a.ref, b.ref);
    expect(files.sort()).toEqual(["x.txt", "y.txt"]);
  });

  it("listChangedFiles returns empty when refs match", async () => {
    const a = await ensureRepo(workDir);
    expect(await listChangedFiles(workDir, a.ref, a.ref)).toEqual([]);
  });
});

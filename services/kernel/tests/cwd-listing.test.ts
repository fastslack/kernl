import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirLevel } from "../src/modules/agents/routes/cwd-listing.js";

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cwd-listing-"));
  mkdirSync(join(root, "web/src"), { recursive: true });
  mkdirSync(join(root, "node_modules/x"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "shots"), { recursive: true });
  writeFileSync(join(root, "README.md"), "hello");
  writeFileSync(join(root, "web/src/a.ts"), "a");
  writeFileSync(join(root, "web/package.json"), "{}");
  mkdirSync(join(root, "web/node_modules"), { recursive: true });
  for (let i = 0; i < 12; i++) writeFileSync(join(root, `shots/${String(i).padStart(2, "0")}.png`), "x");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("listDirLevel", () => {
  it("lists one level, folders first, without node_modules or .git", async () => {
    const l = await listDirLevel(root, "");
    expect(l!.entries.map((e) => e.path)).toEqual(["shots", "web", "README.md"]);
    expect(l!.truncated).toBe(false);
  });

  it("counts a folder's entries without opening it, skipped names excluded", async () => {
    const l = await listDirLevel(root, "");
    expect(l!.entries.find((e) => e.path === "web")).toEqual({ path: "web", type: "dir", size: 0, count: 2 });
    expect(l!.entries.find((e) => e.path === "README.md")).toEqual({ path: "README.md", type: "file", size: 5 });
  });

  it("lists a subfolder with paths relative to the root", async () => {
    const l = await listDirLevel(root, "web/");
    expect(l!.dir).toBe("web");
    expect(l!.entries.map((e) => e.path)).toEqual(["web/src", "web/package.json"]);
  });

  it("cuts a big folder and says how many it holds", async () => {
    const l = await listDirLevel(root, "shots", 5);
    expect(l!.entries).toHaveLength(5);
    expect(l!.total).toBe(12);
    expect(l!.truncated).toBe(true);
  });

  it("refuses a folder outside the root, and one that does not exist", async () => {
    expect(await listDirLevel(root, "../")).toBeNull();
    expect(await listDirLevel(root, "web/../../etc")).toBeNull();
    expect(await listDirLevel(root, "nope")).toBeNull();
    expect(await listDirLevel(root, "README.md")).toBeNull();
  });
});

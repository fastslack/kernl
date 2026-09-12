/**
 * The workspace panel shows a tree the API never sends: the server returns a
 * flat list of paths. Every rule that turns one into the other — implied
 * directories, recursive counts, collapsing, ordering — is here.
 */

import { describe, it, expect } from "bun:test";
import {
  isWorkspacePathHidden,
  buildWsRows,
  wsFileIcon,
  wsFmtSize,
  type WsTreeRow,
} from "./workspace-tree.js";

const file = (path: string, size = 10) => ({ path, type: "file", size });
const dir = (path: string) => ({ path, type: "dir", size: 0 });

describe("isWorkspacePathHidden", () => {
  it("hides lockfiles and OS junk by basename", () => {
    expect(isWorkspacePathHidden("bun.lockb")).toBe(true);
    expect(isWorkspacePathHidden("a/b/package-lock.json")).toBe(true);
    expect(isWorkspacePathHidden("src/.DS_Store")).toBe(true);
  });

  it("hides build leftovers by extension", () => {
    expect(isWorkspacePathHidden("tsconfig.tsbuildinfo")).toBe(true);
  });

  it("hides anything under a bun cache directory", () => {
    expect(isWorkspacePathHidden(".bun/install/cache/x.ts")).toBe(true);
    expect(isWorkspacePathHidden(".bun-tmp/y.ts")).toBe(true);
  });

  it("keeps ordinary source files", () => {
    expect(isWorkspacePathHidden("src/index.ts")).toBe(false);
    expect(isWorkspacePathHidden("README.md")).toBe(false);
  });
});

describe("buildWsRows", () => {
  const paths = (rows: WsTreeRow[]) => rows.map(r => r.path);

  it("derives directories from file parents, even with no dir entries", () => {
    const rows = buildWsRows([file("src/lib/a.ts")], new Set());
    expect(paths(rows)).toEqual(["src", "src/lib", "src/lib/a.ts"]);
  });

  it("nests depth by level", () => {
    const rows = buildWsRows([file("src/lib/a.ts")], new Set());
    expect(rows.map(r => r.depth)).toEqual([0, 1, 2]);
  });

  it("lists directories before files and sorts each group", () => {
    const rows = buildWsRows([file("b.ts"), file("a.ts"), dir("z")], new Set());
    expect(paths(rows)).toEqual(["z", "a.ts", "b.ts"]);
  });

  it("counts files recursively on each directory", () => {
    const rows = buildWsRows(
      [file("src/a.ts"), file("src/deep/b.ts"), file("src/deep/c.ts")],
      new Set(),
    );
    const src = rows.find(r => r.path === "src");
    const deep = rows.find(r => r.path === "src/deep");
    expect(src?.fileCount).toBe(3);
    expect(deep?.fileCount).toBe(2);
  });

  it("skips the children of a collapsed directory but keeps its count", () => {
    const files = [file("src/a.ts"), file("src/deep/b.ts")];
    const rows = buildWsRows(files, new Set(["src/deep"]));
    expect(paths(rows)).toEqual(["src", "src/deep", "src/a.ts"]);
    expect(rows.find(r => r.path === "src/deep")?.fileCount).toBe(1);
  });

  it("carries the file size through and leaves directories at zero", () => {
    const rows = buildWsRows([file("a.ts", 1234)], new Set());
    expect(rows[0]).toMatchObject({ path: "a.ts", isDir: false, size: 1234 });
  });

  it("is empty for an empty workspace", () => {
    expect(buildWsRows([], new Set())).toEqual([]);
  });
});

describe("wsFileIcon", () => {
  it("maps known extensions", () => {
    expect(wsFileIcon("index.ts")).toBe("🔷");
    expect(wsFileIcon("page.svelte")).toBe("🧩");
  });

  it("treats dotfiles as config regardless of extension", () => {
    expect(wsFileIcon(".env")).toBe("🔧");
  });

  it("falls back to a plain page for anything unknown", () => {
    expect(wsFileIcon("LICENSE")).toBe("📄");
    expect(wsFileIcon("thing.xyz")).toBe("📄");
  });
});

describe("wsFmtSize", () => {
  it("switches unit at each threshold", () => {
    expect(wsFmtSize(512)).toBe("512 B");
    expect(wsFmtSize(1024)).toBe("1.0 KB");
    expect(wsFmtSize(1048576)).toBe("1.0 MB");
  });
});

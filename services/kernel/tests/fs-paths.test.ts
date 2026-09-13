import { describe, it, expect } from "bun:test";
import path from "node:path";
import {
  isPathInside,
  toPosixPath,
  toPermissionRulePath,
  findOnPath,
  shellCommand,
  spawnableCommand,
  renameWithRetrySync,
} from "../src/core/fs-paths.js";

const win = { path: path.win32 };

describe("isPathInside", () => {
  it("accepts a child and the root itself on POSIX", () => {
    expect(isPathInside("/srv/app", "/srv/app/a/b.js")).toBe(true);
    expect(isPathInside("/srv/app", "/srv/app")).toBe(true);
    expect(isPathInside("/srv/app", "/srv/app", { allowRoot: false })).toBe(false);
  });

  it("rejects siblings sharing a prefix and parent escapes", () => {
    expect(isPathInside("/srv/app", "/srv/app-2/x")).toBe(false);
    expect(isPathInside("/srv/app", "/srv/app/../secret")).toBe(false);
  });

  it("keeps a child whose name starts with two dots", () => {
    expect(isPathInside("/srv/app", "/srv/app/..hidden")).toBe(true);
  });

  it("accepts backslash children on win32 — the case startsWith(root + '/') missed", () => {
    const root = "C:\\Program Files\\Kernl\\assets\\extensions\\leisure\\cinema\\frontend";
    expect(isPathInside(root, `${root}\\entry.js`, win)).toBe(true);
  });

  it("is case-insensitive and rejects other drives on win32", () => {
    expect(isPathInside("C:\\Kernl\\data", "c:\\kernl\\DATA\\x.db", win)).toBe(true);
    expect(isPathInside("C:\\Kernl\\data", "D:\\Kernl\\data\\x.db", win)).toBe(false);
    expect(isPathInside("C:\\Kernl\\data", "C:\\Kernl\\data-old\\x", win)).toBe(false);
  });
});

describe("toPosixPath", () => {
  it("turns backslashes into forward slashes", () => {
    expect(toPosixPath("data\\workspaces\\a")).toBe("data/workspaces/a");
  });
});

describe("findOnPath", () => {
  it("tries PATHEXT extensions on win32", () => {
    const hits = new Set(["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"]);
    const found = findOnPath("claude", {
      platform: "win32",
      env: { Path: "C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm", PATHEXT: ".EXE;.CMD" },
      exists: c => hits.has(c),
    });
    expect(found).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("prefers the earlier PATH entry and the earlier extension", () => {
    const hits = new Set(["C:\\a\\tool.cmd", "C:\\a\\tool.exe", "C:\\b\\tool.exe"]);
    const found = findOnPath("tool", {
      platform: "win32",
      env: { PATH: "C:\\a;C:\\b", PATHEXT: ".EXE;.CMD" },
      exists: c => hits.has(c),
    });
    expect(found).toBe("C:\\a\\tool.exe");
  });

  it("uses the bare name on POSIX", () => {
    const found = findOnPath("git", {
      platform: "linux",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      exists: c => c === "/usr/bin/git",
    });
    expect(found).toBe("/usr/bin/git");
  });

  it("returns null when nothing matches", () => {
    expect(findOnPath("nope", { platform: "win32", env: { PATH: "C:\\x" }, exists: () => false })).toBeNull();
  });
});

describe("shellCommand / spawnableCommand", () => {
  it("uses cmd.exe on win32 and sh elsewhere", () => {
    expect(shellCommand("dir", { platform: "win32", env: {} }).file).toBe("cmd.exe");
    expect(shellCommand("ls", { platform: "linux" })).toEqual({ file: "/bin/sh", args: ["-c", "ls"], windowsVerbatimArguments: false });
  });

  it("wraps .cmd shims on win32 only", () => {
    expect(spawnableCommand("C:\\npm\\claude.cmd", ["-v"], { platform: "win32", env: {} }))
      .toEqual({ file: "cmd.exe", args: ["/d", "/c", "C:\\npm\\claude.cmd", "-v"] });
    expect(spawnableCommand("C:\\x\\claude.exe", ["-v"], { platform: "win32", env: {} }))
      .toEqual({ file: "C:\\x\\claude.exe", args: ["-v"] });
  });
});

describe("toPermissionRulePath", () => {
  it("doubles the leading slash on POSIX so the rule is absolute", () => {
    expect(toPermissionRulePath("/app/data/workspaces/a", "linux")).toBe("//app/data/workspaces/a");
    expect(toPermissionRulePath("/app/data/workspaces/a/", "linux")).toBe("//app/data/workspaces/a");
  });

  it("uses the CLI's /c/ form on Windows", () => {
    expect(toPermissionRulePath("C:\\Users\\me\\AppData\\Local\\Kernl\\data\\workspaces\\agent-1", "win32"))
      .toBe("//c/Users/me/AppData/Local/Kernl/data/workspaces/agent-1");
    expect(toPermissionRulePath("D:/code/proj/", "win32")).toBe("//d/code/proj");
  });

  it("keeps UNC paths absolute on Windows", () => {
    expect(toPermissionRulePath("\\\\nas\\share\\x", "win32")).toBe("//nas/share/x");
  });
});

describe("renameWithRetrySync", () => {
  const locked = (failures: number, code = "EPERM") => {
    let calls = 0;
    return {
      get calls() { return calls; },
      rename: () => {
        calls++;
        if (calls <= failures) throw Object.assign(new Error(code), { code });
      },
    };
  };

  it("retries a transient lock on win32 until the rename lands", () => {
    const r = locked(2);
    renameWithRetrySync("a", "b", { platform: "win32", rename: r.rename });
    expect(r.calls).toBe(3);
  });

  it("does not retry on POSIX, where EPERM is permanent", () => {
    const r = locked(1);
    expect(() => renameWithRetrySync("a", "b", { platform: "linux", rename: r.rename })).toThrow("EPERM");
    expect(r.calls).toBe(1);
  });

  it("gives up after the attempt budget", () => {
    const r = locked(10, "EBUSY");
    expect(() => renameWithRetrySync("a", "b", { platform: "win32", attempts: 3, rename: r.rename })).toThrow("EBUSY");
    expect(r.calls).toBe(3);
  });
});

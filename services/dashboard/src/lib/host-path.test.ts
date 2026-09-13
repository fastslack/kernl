import { describe, it, expect } from "bun:test";
import {
  isAbsoluteHostPath,
  hostPathSep,
  splitHostPath,
  joinHostPath,
  parentHostPath,
  basenameHostPath,
  hostPathCrumbs,
  isUnderHostPath,
} from "./host-path.js";

describe("isAbsoluteHostPath", () => {
  it("accepts POSIX, drive and UNC paths", () => {
    expect(isAbsoluteHostPath("/srv/repo")).toBe(true);
    expect(isAbsoluteHostPath("C:\\code\\proj")).toBe(true);
    expect(isAbsoluteHostPath("d:/code/proj")).toBe(true);
    expect(isAbsoluteHostPath("\\\\server\\share\\x")).toBe(true);
  });

  it("rejects relative paths, bare drives and non-strings", () => {
    expect(isAbsoluteHostPath("rel/path")).toBe(false);
    expect(isAbsoluteHostPath("C:foo")).toBe(false);
    expect(isAbsoluteHostPath("~/proj")).toBe(false);
    expect(isAbsoluteHostPath("")).toBe(false);
    expect(isAbsoluteHostPath(undefined)).toBe(false);
  });
});

describe("splitHostPath / hostPathSep", () => {
  it("splits each flavour into root and parts", () => {
    expect(splitHostPath("/home/me/x")).toEqual({ root: "/", parts: ["home", "me", "x"] });
    expect(splitHostPath("C:\\Users\\me\\")).toEqual({ root: "C:\\", parts: ["Users", "me"] });
    expect(splitHostPath("\\\\nas\\media\\films")).toEqual({ root: "\\\\nas\\media\\", parts: ["films"] });
    expect(splitHostPath("a/b")).toEqual({ root: "", parts: ["a", "b"] });
  });

  it("keeps the separator a path is written with", () => {
    expect(hostPathSep("C:\\x")).toBe("\\");
    expect(hostPathSep("C:/x/y")).toBe("/");
    expect(hostPathSep("/x")).toBe("/");
  });
});

describe("join / parent / basename", () => {
  it("joins with the base's separator", () => {
    expect(joinHostPath("C:\\Users\\me", "Docs")).toBe("C:\\Users\\me\\Docs");
    expect(joinHostPath("C:\\", "Users")).toBe("C:\\Users");
    expect(joinHostPath("/home/me", "Docs")).toBe("/home/me/Docs");
    expect(joinHostPath("/", "etc")).toBe("/etc");
  });

  it("walks up to the root and stops there", () => {
    expect(parentHostPath("C:\\Users\\me")).toBe("C:\\Users");
    expect(parentHostPath("C:\\Users")).toBe("C:\\");
    expect(parentHostPath("C:\\")).toBe("C:\\");
    expect(parentHostPath("/home")).toBe("/");
    expect(parentHostPath("/")).toBe("/");
    expect(parentHostPath("\\\\nas\\media\\films")).toBe("\\\\nas\\media\\");
  });

  it("names the last segment, or the root", () => {
    expect(basenameHostPath("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
    expect(basenameHostPath("/home/me/")).toBe("me");
    expect(basenameHostPath("C:\\")).toBe("C:\\");
    expect(basenameHostPath("/")).toBe("/");
  });
});

describe("hostPathCrumbs", () => {
  it("builds openable crumbs for a Windows path", () => {
    expect(hostPathCrumbs("C:\\Users\\me")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "me", path: "C:\\Users\\me" },
    ]);
  });

  it("matches the old POSIX crumbs", () => {
    expect(hostPathCrumbs("/home/me")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "me", path: "/home/me" },
    ]);
  });
});

describe("isUnderHostPath", () => {
  it("handles POSIX prefixes without matching siblings", () => {
    expect(isUnderHostPath("/home/me/x", "/home/me")).toBe(true);
    expect(isUnderHostPath("/home/me", "/home/me/")).toBe(true);
    expect(isUnderHostPath("/home/me-2", "/home/me")).toBe(false);
    expect(isUnderHostPath("/anything", "/")).toBe(true);
  });

  it("is case- and separator-insensitive for Windows paths", () => {
    expect(isUnderHostPath("c:/users/ME/docs", "C:\\Users\\me")).toBe(true);
    expect(isUnderHostPath("C:\\Users\\me2", "C:\\Users\\me")).toBe(false);
    expect(isUnderHostPath("D:\\x", "C:\\")).toBe(false);
    expect(isUnderHostPath("C:\\x", "C:\\")).toBe(true);
  });

  it("never mixes flavours", () => {
    expect(isUnderHostPath("C:\\x", "/")).toBe(false);
    expect(isUnderHostPath("/x", "C:\\")).toBe(false);
  });
});

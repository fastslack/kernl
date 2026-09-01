/**
 * The helper script that finishes an update.
 *
 * It runs when nothing is left to supervise it — the kernel has exited and its
 * own directory is about to be replaced — so the properties below are the ones
 * that decide whether a failed update is recoverable or leaves someone with no
 * application at all.
 *
 * Generated as text and tested as text, because the alternative is finding out
 * on the one platform that is not this one.
 */
import { describe, it, expect } from "bun:test";
import { helperFor, helperFilename } from "../src/core/update/helper.js";

const args = {
  pid: 4242,
  staged: "/tmp/kernl-x/Kernl.app",
  target: "/Applications/Kernl.app",
  backup: "/tmp/kernl-x/backup",
  relaunch: "/Applications/Kernl.app",
};

describe("every platform's helper", () => {
  for (const kind of ["macos-app", "linux-portable", "windows-dir"] as const) {
    describe(kind, () => {
      const script = helperFor(kind, args);

      it("waits for the kernel to exit before touching anything", () => {
        expect(script).toContain("4242");
        // Swapping a directory out from under a live process is the one thing
        // that must never happen.
        const waitIdx = script.indexOf("4242");
        const swapIdx = script.search(/mv |move |Move-Item/i);
        expect(waitIdx).toBeLessThan(swapIdx);
      });

      it("gives up waiting instead of hanging forever", () => {
        // If the process never dies the helper must do nothing at all — a
        // helper stuck in a loop is a process nobody knows to kill.
        expect(script).toMatch(/60|timeout|-gt/i);
      });

      it("keeps the old copy until the new one is in place", () => {
        expect(script).toContain(args.backup);
      });

      it("puts the old copy back when the swap fails", () => {
        // An update that fails is recoverable; one that leaves nothing behind
        // is not.
        const restore = script.lastIndexOf(args.backup);
        const firstUse = script.indexOf(args.backup);
        expect(restore).toBeGreaterThan(firstUse);
      });

      it("relaunches", () => {
        expect(script).toContain(args.relaunch);
      });
    });
  }
});

describe("what differs per platform", () => {
  it("strips the quarantine attribute on macOS only", () => {
    // A downloaded bundle is quarantined; without this Gatekeeper refuses the
    // relaunch and the update reports success while leaving an app that will
    // not open.
    expect(helperFor("macos-app", args)).toContain("com.apple.quarantine");
    expect(helperFor("linux-portable", args)).not.toContain("com.apple.quarantine");
    expect(helperFor("windows-dir", args)).not.toContain("com.apple.quarantine");
  });

  it("uses `open` on macOS and the binary itself on Linux", () => {
    expect(helperFor("macos-app", args)).toMatch(/\bopen\b/);
    expect(helperFor("linux-portable", args)).not.toMatch(/^open /m);
  });

  it("writes a batch file on Windows and a shell script elsewhere", () => {
    expect(helperFilename("windows-dir")).toMatch(/\.cmd$/);
    expect(helperFilename("macos-app")).toMatch(/\.sh$/);
    expect(helperFilename("linux-portable")).toMatch(/\.sh$/);
    expect(helperFor("windows-dir", args)).not.toContain("#!/bin/sh");
    expect(helperFor("macos-app", args)).toContain("#!/bin/sh");
  });

  it("quotes every path, so a space in the install location is not a bug", () => {
    // "C:\Program Files\Kernl" and "/Applications/My Apps/Kernl.app" are both
    // ordinary, and an unquoted path turns either into two broken arguments.
    const spaced = { ...args, target: "/Applications/My Apps/Kernl.app" };
    for (const kind of ["macos-app", "linux-portable", "windows-dir"] as const) {
      const s = helperFor(kind, spaced);
      expect(s).toContain('"/Applications/My Apps/Kernl.app"');
    }
  });
});

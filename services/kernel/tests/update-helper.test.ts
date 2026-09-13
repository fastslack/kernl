/**
 * The helper script that finishes an update.
 *
 * It runs when nothing is left to supervise it — the kernel has exited and its
 * own directory is about to be replaced — so the properties below are the ones
 * that decide whether a failed update is recoverable or leaves someone with no
 * application at all.
 *
 * Generated as text and tested as text, because the alternative is finding out
 * on the one platform that is not this one. Every assertion here corresponds
 * to something that was actually wrong: a sleep that refuses to run when stdin
 * is redirected, an unchecked move that nested the new install inside the old
 * one, and a relaunch that pointed at a directory.
 */
import { describe, it, expect } from "bun:test";
import { helperFor, helperFilename } from "../src/core/update/helper.js";

const args = {
  pid: 4242,
  staged: "/tmp/kernl-x/Kernl.app",
  target: "/Applications/Kernl.app",
  backup: "/tmp/kernl-x/backup",
  relaunch: ["open", "/Applications/Kernl.app"],
};

/** The kinds that replace a directory themselves. */
const SWAP_KINDS = ["macos-app", "linux-portable", "windows-dir"] as const;

describe("every swapping helper", () => {
  for (const kind of SWAP_KINDS) {
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
        expect(script).toMatch(/60/);
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

      it("stops if parking the old copy fails, rather than moving onto it", () => {
        // The unchecked `move` was the dangerous one. On Windows, MOVE into an
        // existing directory moves INTO it: a denied first move meant the new
        // tree landed inside the old install, errorlevel said 0, and the
        // "backup" that was deleted afterwards had never been created.
        const parkIdx = script.indexOf(args.backup);
        const guard = script.slice(parkIdx).search(/if errorlevel 1|if ! mv/);
        expect(guard).toBeGreaterThanOrEqual(0);
      });

      it("relaunches a command, not a directory", () => {
        expect(script).toContain(args.relaunch[args.relaunch.length - 1]!);
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
    const linux = helperFor("linux-portable", {
      ...args,
      relaunch: ["/home/me/kernl/bin/bun", "/home/me/kernl/bin/mcp-server.js"],
    });
    expect(linux).toContain('"/home/me/kernl/bin/bun" "/home/me/kernl/bin/mcp-server.js"');
    expect(linux).not.toMatch(/^open /m);
  });

  it("writes a batch file on Windows and a shell script elsewhere", () => {
    expect(helperFilename("windows-dir")).toMatch(/\.cmd$/);
    expect(helperFilename("windows-msi")).toMatch(/\.cmd$/);
    expect(helperFilename("macos-app")).toMatch(/\.sh$/);
    expect(helperFilename("linux-portable")).toMatch(/\.sh$/);
    expect(helperFor("windows-dir", args)).not.toContain("#!/bin/sh");
    expect(helperFor("macos-app", args)).toContain("#!/bin/sh");
  });

  it("never sleeps with `timeout` on Windows", () => {
    // `timeout` exits immediately with "Input redirection is not supported"
    // when stdin is redirected, which it always is here — the helper is
    // spawned with its stdio ignored. The loop burned its sixty tries in
    // milliseconds and exited without swapping anything: the kernel had
    // already quit, so the user got a closed app, no update, and no relaunch.
    for (const kind of ["windows-dir", "windows-msi"] as const) {
      const script = helperFor(kind, { ...args, installer: "C:\\tmp\\kernl.msi" });
      expect(script).not.toMatch(/^\s*timeout\b/m);
      expect(script).toMatch(/ping\.exe" -n 2 127\.0\.0\.1/);
    }
  });

  it("calls Windows' own find, tasklist and msiexec by full path", () => {
    // Git for Windows puts GNU find on PATH. It does not filter stdin for a
    // string, so the wait loop ended at once and the swap ran with the kernel
    // still alive.
    for (const kind of ["windows-dir", "windows-msi"] as const) {
      const script = helperFor(kind, { ...args, installer: "C:\\tmp\\kernl.msi" });
      expect(script).toContain('"%SYS%\\find.exe"');
      expect(script).toContain('"%SYS%\\tasklist.exe"');
      expect(script).not.toMatch(/\| find "/);
    }
    expect(helperFor("windows-msi", { ...args, installer: "C:\\x.msi" })).toContain('"%SYS%\\msiexec.exe"');
  });

  it("quotes every path, so a space in the install location is not a bug", () => {
    // "C:\Program Files\Kernl" and "/Applications/My Apps/Kernl.app" are both
    // ordinary, and an unquoted path turns either into two broken arguments.
    const spaced = { ...args, target: "/Applications/My Apps/Kernl.app" };
    for (const kind of SWAP_KINDS) {
      const s = helperFor(kind, spaced);
      expect(s).toContain('"/Applications/My Apps/Kernl.app"');
    }
  });
});

describe("the MSI helper", () => {
  const msiArgs = {
    ...args,
    target: "C:\\Program Files\\Kernl",
    installer: "C:\\Users\\me\\AppData\\Local\\Temp\\kernl-0.4.0-windows-x64.msi",
    relaunch: ["C:\\Program Files\\Kernl\\start.bat"],
  };
  const script = helperFor("windows-msi", msiArgs);

  it("hands the package to msiexec instead of moving anything", () => {
    // The MSI owns its registry entry, its uninstaller and its elevation
    // prompt. Swapping the directory underneath it leaves Add/Remove Programs
    // advertising a version that is no longer on disk.
    expect(script).toContain(`msiexec.exe" /i "${msiArgs.installer}"`);
    expect(script).not.toMatch(/^move /m);
    expect(script).not.toContain(args.backup);
  });

  it("shows the installer's progress rather than failing behind a silent UAC prompt", () => {
    expect(script).toContain("/qb");
    expect(script).toContain("/norestart");
  });

  it("waits for the kernel to exit first, because msiexec cannot replace open files", () => {
    const waitIdx = script.indexOf("4242");
    // The COMMAND, not the word: a comment explaining why it has to wait for
    // msiexec would pass for free.
    const upgradeIdx = script.indexOf('msiexec.exe" /i');
    expect(waitIdx).toBeGreaterThanOrEqual(0);
    expect(waitIdx).toBeLessThan(upgradeIdx);
  });

  it("treats a pending reboot as success and a declined prompt as something to report", () => {
    // 3010 used to count as failure, and a declined UAC prompt (1602) just
    // exited — with the kernel already gone.
    expect(script).toContain('if "%rc%"=="3010" goto installed');
    expect(script).toContain('if "%rc%"=="1602" goto cancelled');
    expect(script).toContain("uac-declined");
  });

  it("starts the previous version again when the installer fails or is declined", () => {
    for (const marker of ["msiexec-%rc%", ":cancelled"]) {
      const tail = script.slice(script.indexOf(marker));
      expect(tail.indexOf("call :relaunch")).toBeGreaterThanOrEqual(0);
      expect(tail.indexOf("call :relaunch")).toBeLessThan(tail.indexOf("exit /b 1"));
    }
  });

  it("starts Kernl again once the installer is done", () => {
    expect(script).toContain('start "" "C:\\Program Files\\Kernl\\start.bat"');
  });
});

describe("every way out of a swap", () => {
  const withResult = {
    ...args,
    resultFile: "/data/update-result.json",
    version: "0.4.0",
    healthUrl: "http://127.0.0.1:3086/api/health",
  };

  for (const kind of SWAP_KINDS) {
    const script = helperFor(kind, withResult);

    it(`${kind}: starts Kernl again when the old copy cannot be moved aside`, () => {
      // The kernel has already exited by now. A helper that just stopped here
      // left the user with no application running.
      const tail = script.slice(script.indexOf("move-aside"));
      const relaunch = tail.search(/relaunch/);
      expect(relaunch).toBeGreaterThanOrEqual(0);
      expect(relaunch).toBeLessThan(tail.search(/exit (\/b )?1/));
    });

    it(`${kind}: records what happened for the next boot`, () => {
      expect(script).toContain("/data/update-result.json");
      for (const code of ["move-aside", "move-in", "new-version-did-not-start", "rolled-back"]) {
        expect(script).toContain(code);
      }
    });

    it(`${kind}: puts the previous copy back when the new version never answers`, () => {
      expect(script).toContain(withResult.healthUrl);
      expect(script).toContain(`${args.target}.failed`);
    });
  }

  it("retries a Windows move while a just-closed file is still locked", () => {
    const script = helperFor("windows-dir", withResult);
    expect(script).toContain(":park_retry");
    expect(script).toContain(":movein_retry");
  });
});

/**
 * What the next kernel does with the update that just ended.
 *
 * Nothing used to come back from a helper: the dashboard said "restarting"
 * forever and the parked previous copy, the download and the staging folder
 * stayed on disk after every update. These run against a throwaway data
 * directory, the same way the kernel resolves it — relative to the working
 * directory.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeUpdateCode, finalizeUpdateOnBoot, recordAttempt, updateResultFile } from "../src/core/update/install.js";
import { currentVersion } from "../src/core/update/version.js";

let home: string;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  home = mkdtempSync(join(tmpdir(), "kernl-update-test-"));
  process.chdir(home);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(home, { recursive: true, force: true });
});

function attempt(to: string, startedAt = Date.now()) {
  const staging = join(home, ".kernl-update-x");
  const backup = join(home, "Kernl.previous");
  mkdirSync(staging, { recursive: true });
  mkdirSync(backup, { recursive: true });
  recordAttempt({
    from: "0.0.1",
    to,
    kind: "windows-dir",
    target: join(home, "Kernl"),
    backup,
    staging,
    startedAt,
  });
  return { staging, backup };
}

describe("finalizeUpdateOnBoot", () => {
  it("does nothing when there was no update", () => {
    expect(finalizeUpdateOnBoot()).toBeNull();
  });

  it("calls it done when this kernel is the version that was installed, and cleans up", () => {
    const running = currentVersion()!;
    const { staging, backup } = attempt(running);
    const last = finalizeUpdateOnBoot();
    expect(last?.result).toBe("ok");
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(backup)).toBe(false);
    // Settled once, remembered for the UI.
    expect(JSON.parse(readFileSync(join(home, "data", "update-last.json"), "utf-8")).result).toBe("ok");
    expect(existsSync(join(home, "data", "update-attempt.json"))).toBe(false);
  });

  it("reports the helper's failure in words and keeps the previous copy", () => {
    const { staging, backup } = attempt("99.0.0");
    writeFileSync(updateResultFile(), JSON.stringify({ version: "99.0.0", result: "failed", code: "uac-declined" }));
    const last = finalizeUpdateOnBoot();
    expect(last?.result).toBe("failed");
    expect(last?.message).toContain("administrator prompt");
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(backup)).toBe(true);
  });

  it("waits while an attempt is young and silent — an installer can sit at its prompt", () => {
    attempt("99.0.0");
    expect(finalizeUpdateOnBoot()).toBeNull();
    expect(existsSync(join(home, "data", "update-attempt.json"))).toBe(true);
  });

  it("gives up on an attempt that never reported back", () => {
    attempt("99.0.0", Date.now() - 60 * 60 * 1000);
    const last = finalizeUpdateOnBoot();
    expect(last?.result).toBe("failed");
    expect(last?.code).toBe("no-result");
  });
});

describe("describeUpdateCode", () => {
  it("turns the helper's codes into something a person can act on", () => {
    expect(describeUpdateCode("msiexec-1603")).toContain("1603");
    expect(describeUpdateCode("move-aside")).toContain("still in use");
    expect(describeUpdateCode("new-version-did-not-start")).toContain("previous one");
    expect(describeUpdateCode("something-new")).toContain("something-new");
  });
});

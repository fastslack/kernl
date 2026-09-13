import { describe, it, expect } from "bun:test";
import { planRestart } from "../src/core/update/restart.js";
import { restartHelperFor } from "../src/core/update/helper.js";

const base = { env: {}, cgroup: "", hasLauncher: false };

describe("planRestart", () => {
  it("lets the container's restart policy do it under Docker", () => {
    expect(planRestart({ kind: "docker", target: null, canApply: false }, base)).toEqual({ kind: "container" });
  });

  it("relaunches start.bat for both Windows installs", () => {
    for (const kind of ["windows-dir", "windows-msi"] as const) {
      expect(planRestart({ kind, target: "C:\\Program Files\\Kernl", canApply: true }, base)).toEqual({
        kind: "helper",
        windows: true,
        relaunch: ["C:\\Program Files\\Kernl\\start.bat"],
      });
    }
  });

  it("reopens the app bundle on macOS", () => {
    expect(planRestart({ kind: "macos-app", target: "/Applications/Kernl.app", canApply: true }, base))
      .toEqual({ kind: "helper", windows: false, relaunch: ["open", "/Applications/Kernl.app"] });
  });

  it("uses the tarball's own launcher when it ships one", () => {
    const plan = planRestart(
      { kind: "linux-portable", target: "/home/me/kernl", canApply: true },
      { ...base, hasLauncher: true },
    );
    expect(plan).toEqual({ kind: "helper", windows: false, relaunch: ["/home/me/kernl/kernl"] });
  });

  it("hands an rpm/deb under a systemd user unit to systemd", () => {
    const plan = planRestart(
      { kind: "linux-package", target: "/opt/kernl", canApply: true },
      {
        env: { INVOCATION_ID: "x" },
        cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/kernl.service\n",
        hasLauncher: false,
      },
    );
    expect(plan).toEqual({ kind: "systemd", method: { kind: "systemd-user", unit: "kernl.service" } });
  });

  it("relaunches /usr/bin/kernl for an rpm/deb started by hand", () => {
    expect(planRestart({ kind: "linux-package", target: "/opt/kernl", canApply: true }, base))
      .toEqual({ kind: "helper", windows: false, relaunch: ["/usr/bin/kernl"] });
  });

  it("refuses a source checkout, which has no entry point to relaunch", () => {
    expect(planRestart({ kind: "unknown", target: null, canApply: false }, base).kind).toBe("refuse");
  });
});

describe("restartHelperFor", () => {
  const args = {
    pid: 4242,
    staged: "",
    target: "C:\\Program Files\\Kernl",
    backup: "",
    relaunch: ["C:\\Program Files\\Kernl\\start.bat"],
    healthUrl: "http://127.0.0.1:3086/api/health",
  };

  it("on Windows waits for the pid, starts start.bat and never moves files", () => {
    const script = restartHelperFor(true, args);
    expect(script).toContain('PID eq 4242');
    expect(script).toContain('start "" "C:\\Program Files\\Kernl\\start.bat"');
    expect(script).not.toMatch(/\bmove\b|rmdir|msiexec/i);
  });

  it("on POSIX waits for the pid and relaunches detached", () => {
    const script = restartHelperFor(false, { ...args, target: "/opt/kernl", relaunch: ["/usr/bin/kernl"] });
    expect(script).toContain("kill -0 4242");
    expect(script).toContain('nohup "/usr/bin/kernl"');
    expect(script).not.toMatch(/\bmv\b|rm -rf/);
  });
});

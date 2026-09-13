/**
 * The parts of in-app update that differ per install, decided without the
 * install: macOS bundles, package installs, containers and restarts.
 *
 * Each case here is one that shipped broken. macOS computed its bundle path
 * two folders too high and refused every update; package installs were told to
 * run an `apt upgrade` that finds nothing; Docker got a button that could only
 * refuse; and a tarball read a stranger's package.json as its own version.
 */
import { describe, it, expect } from "bun:test";
import {
  descendantsOf,
  isContainer,
  macBundleFromModuleDir,
  macUpdateBlocker,
  packageAssetSpec,
  packageInstallPlan,
  parentFromProcStat,
  relaunchCommandFor,
  restartMethodFor,
} from "../src/core/update/platform.js";
import { helperFor } from "../src/core/update/helper.js";
import { versionCandidates } from "../src/core/update/version.js";

describe("macBundleFromModuleDir", () => {
  it("finds the bundle the packaged server runs inside", () => {
    // The regression: two levels up from Resources is Kernl.app, and the old
    // check insisted on a path ending in `.app/Contents`.
    expect(macBundleFromModuleDir("/Applications/Kernl.app/Contents/Resources"))
      .toBe("/Applications/Kernl.app");
    expect(macBundleFromModuleDir("/Users/me/Apps/My Kernl.app/Contents/Resources/bin"))
      .toBe("/Users/me/Apps/My Kernl.app");
  });

  it("finds nothing outside a bundle", () => {
    expect(macBundleFromModuleDir("/Users/me/src/kernl/services/kernel/src/core/update")).toBeNull();
    expect(macBundleFromModuleDir("/Applications/Kernl.app")).toBeNull();
  });
});

describe("macUpdateBlocker", () => {
  const ok = { parentWritable: true, bundleWritable: true };

  it("lets a writable bundle in /Applications update", () => {
    expect(macUpdateBlocker("/Applications/Kernl.app", ok)).toBeNull();
  });

  it("refuses a translocated app before anything is downloaded", () => {
    const b = macUpdateBlocker("/private/var/folders/x/T/AppTranslocation/ABC/d/Kernl.app", ok);
    expect(b?.useInstead).toContain("/Applications");
  });

  it("refuses an app running from its disk image", () => {
    expect(macUpdateBlocker("/Volumes/Kernl/Kernl.app", ok)?.reason).toContain("disk image");
  });

  it("says so when the account cannot replace apps there", () => {
    const b = macUpdateBlocker("/Applications/Kernl.app", { parentWritable: false, bundleWritable: true });
    expect(b?.reason).toContain("/Applications");
  });
});

describe("package installs", () => {
  it("matches the packages v0.3.0 actually published", () => {
    expect(packageAssetSpec("0.3.0", "rpm", "x64")!.pattern.test("kernl-0.3.0-1.x86_64.rpm")).toBe(true);
    expect(packageAssetSpec("0.3.0", "deb", "x64")!.pattern.test("kernl_0.3.0-1_amd64.deb")).toBe(true);
    expect(packageAssetSpec("0.3.0", "rpm", "x64")!.pattern.test("kernl_0.3.0-1_amd64.deb")).toBe(false);
    expect(packageAssetSpec("0.3.0", "deb", "arm64")).toBeNull();
  });

  const tools = (have: string[]) => (t: string) => (have.includes(t) ? `/usr/bin/${t}` : null);

  it("installs through pkexec with the distribution's own tool", () => {
    const rpm = packageInstallPlan("rpm", "/d/kernl.rpm", { isRoot: false, find: tools(["pkexec", "dnf", "rpm"]) });
    expect(rpm.argv).toEqual(["/usr/bin/pkexec", "/usr/bin/dnf", "install", "-y", "/d/kernl.rpm"]);
    const deb = packageInstallPlan("deb", "/d/kernl.deb", { isRoot: false, find: tools(["pkexec", "apt-get", "dpkg"]) });
    expect(deb.argv).toEqual(["/usr/bin/pkexec", "/usr/bin/apt-get", "install", "-y", "/d/kernl.deb"]);
  });

  it("falls back to rpm and dpkg when there is no dnf or apt", () => {
    expect(packageInstallPlan("rpm", "/d/k.rpm", { isRoot: false, find: tools(["pkexec", "rpm"]) }).argv)
      .toEqual(["/usr/bin/pkexec", "/usr/bin/rpm", "-Uvh", "/d/k.rpm"]);
    expect(packageInstallPlan("deb", "/d/k.deb", { isRoot: false, find: tools(["pkexec", "dpkg"]) }).argv)
      .toEqual(["/usr/bin/pkexec", "/usr/bin/dpkg", "-i", "/d/k.deb"]);
  });

  it("gives the exact command for the downloaded file when there is no pkexec", () => {
    // The old hint was `sudo apt upgrade kernl`, which finds nothing: no
    // repository publishes Kernl.
    const plan = packageInstallPlan("deb", "/home/me/.local/share/kernl/data/updates/0.4.0/kernl_0.4.0-1_amd64.deb", {
      isRoot: false,
      find: tools(["apt-get"]),
    });
    expect(plan.argv).toBeNull();
    expect(plan.manual).toBe("sudo apt-get install -y /home/me/.local/share/kernl/data/updates/0.4.0/kernl_0.4.0-1_amd64.deb");
  });

  it("needs no prompt as root", () => {
    expect(packageInstallPlan("rpm", "/d/k.rpm", { isRoot: true, find: tools(["dnf"]) }).argv)
      .toEqual(["/usr/bin/dnf", "install", "-y", "/d/k.rpm"]);
  });

  it("restarts through systemd when systemd runs the kernel", () => {
    const cg = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/kernl.service\n";
    expect(restartMethodFor({ INVOCATION_ID: "x" }, cg)).toEqual({ kind: "systemd-user", unit: "kernl.service" });
    expect(restartMethodFor({ INVOCATION_ID: "x" }, "0::/system.slice/kernl.service"))
      .toEqual({ kind: "systemd-system", unit: "kernl.service" });
    expect(restartMethodFor({}, cg)).toEqual({ kind: "relaunch" });
  });

  it("restarts a hand-started kernel with a helper that swaps nothing", () => {
    const script = helperFor("linux-package", {
      pid: 777, staged: "/d/k.rpm", target: "/opt/kernl", backup: "",
      relaunch: ["/usr/bin/kernl"], resultFile: "/d/r.json", version: "0.4.0",
    });
    expect(script).toContain("kill -0 777");
    expect(script).toContain('"/usr/bin/kernl"');
    expect(script).not.toMatch(/^\s*(if ! )?mv /m);
  });
});

describe("containers", () => {
  it("recognises Docker, Podman and Kubernetes", () => {
    const none = { dockerenv: false, env: {}, cgroup: "0::/init.scope" };
    expect(isContainer(none)).toBe(false);
    expect(isContainer({ ...none, dockerenv: true })).toBe(true);
    expect(isContainer({ ...none, env: { container: "podman" } })).toBe(true);
    expect(isContainer({ ...none, cgroup: "0::/kubepods/besteffort/pod1" })).toBe(true);
  });
});

describe("the tarball launcher", () => {
  it("relaunches through the launcher when the new tree has one", () => {
    expect(relaunchCommandFor("/home/me/kernl", "linux-portable", { launcher: true }))
      .toEqual(["/home/me/kernl/kernl"]);
  });
});

describe("child processes", () => {
  it("finds every descendant and leaves the helper alone", () => {
    const pairs = [
      { pid: 10, ppid: 1 }, { pid: 20, ppid: 10 }, { pid: 21, ppid: 20 },
      { pid: 30, ppid: 10 }, { pid: 31, ppid: 30 }, { pid: 99, ppid: 1 },
    ];
    expect(descendantsOf(10, pairs, [30]).sort()).toEqual([20, 21]);
  });

  it("reads the parent from /proc stat even when the name holds spaces", () => {
    expect(parentFromProcStat("1234 (whisper cli) S 42 1234 1234 0")).toBe(42);
    expect(parentFromProcStat("garbage")).toBeNull();
  });
});

describe("versionCandidates", () => {
  it("looks nearest first, so a tarball under ~/apps never reads ~/package.json", () => {
    const c = versionCandidates("/home/me/apps/kernl-0.4.0/bin");
    expect(c[0]).toBe("/home/me/apps/kernl-0.4.0/bin");
    expect(c[1]).toBe("/home/me/apps/kernl-0.4.0");
    expect(c.indexOf("/home/me")).toBe(2);
  });
});

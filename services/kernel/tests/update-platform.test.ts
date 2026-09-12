/**
 * Which artefact this machine needs, and whether it may update itself at all.
 *
 * Two rules shape this, and both were learned the hard way:
 *
 *   · NEVER fight the package manager. Replacing files under /opt that dpkg or
 *     rpm believes it owns produces a machine where the next `apt upgrade`
 *     undoes the update — worse than not updating.
 *   · NEVER fight the installer either. An MSI owns its registry entry and its
 *     uninstaller; swapping its directory leaves Add/Remove Programs
 *     advertising a version that is not on disk.
 *
 * The asset names live in `update-asset-manifest.test.ts`, checked against the
 * names a real release published — because this file used to assert the
 * hand-built name and pass while that name matched nothing on the release.
 */
import { describe, it, expect } from "bun:test";
import {
  assetSpecFor,
  installKind,
  installRootFrom,
  isSwappable,
  relaunchCommandFor,
  stagingParentFor,
  usesInstaller,
} from "../src/core/update/platform.js";

describe("assetSpecFor", () => {
  it("takes the macOS tarball per architecture", () => {
    expect(assetSpecFor("1.2.0", "macos-app", "arm64")?.expected)
      .toBe("Kernl-1.2.0-arm64-macos.tar.gz");
    expect(assetSpecFor("1.2.0", "macos-app", "x64")?.expected)
      .toBe("Kernl-1.2.0-x64-macos.tar.gz");
  });

  it("takes the zip for an unzipped Windows copy and the MSI for an installed one", () => {
    // Not interchangeable: the zip is a directory to swap, the MSI is an
    // upgrade the operating system performs.
    expect(assetSpecFor("1.2.0", "windows-dir", "x64")?.expected)
      .toBe("kernl-1.2.0-windows-x64.zip");
    expect(assetSpecFor("1.2.0", "windows-msi", "x64")?.expected)
      .toBe("kernl-1.2.0-windows-x64.msi");
  });

  it("takes a portable Linux tarball", () => {
    expect(assetSpecFor("1.2.0", "linux-portable", "x64")?.expected)
      .toBe("Kernl-1.2.0-x64-linux.tar.gz");
  });

  it("matches the published name whatever its capitalisation", () => {
    // The release publishes macOS artefacts as `Kernl-*` and linux/windows
    // ones as `kernl-*`, both deliberately. Matching is what keeps this code
    // from having to care which is which.
    const zip = assetSpecFor("0.3.0", "windows-dir", "x64")!;
    expect(zip.pattern.test("kernl-0.3.0-windows-x64.zip")).toBe(true);
    expect(zip.pattern.test("Kernl-0.3.0-windows-x64.zip")).toBe(true);
  });

  it("does not match a neighbouring asset", () => {
    const zip = assetSpecFor("0.3.0", "windows-dir", "x64")!;
    expect(zip.pattern.test("kernl-0.3.0-windows-x64.msi")).toBe(false);
    const msi = assetSpecFor("0.3.0", "windows-msi", "x64")!;
    expect(msi.pattern.test("kernl-0.3.0-windows-x64.zip")).toBe(false);
    // A different version is a different asset, and the version is regex-escaped
    // so the dots cannot match anything else.
    expect(zip.pattern.test("kernl-0e3e0-windows-x64.zip")).toBe(false);
  });

  it("has nothing to offer a package install or an unrecognised one", () => {
    expect(assetSpecFor("1.2.0", "linux-package", "x64")).toBeNull();
    expect(assetSpecFor("1.2.0", "unknown", "x64")).toBeNull();
  });
});

describe("installKind", () => {
  it("recognises a macOS .app by its layout", () => {
    expect(installKind("/Applications/Kernl.app/Contents/Resources", "darwin")).toBe("macos-app");
  });

  it("does not call a plain directory an .app", () => {
    // Dev runs, Docker and anything unpacked by hand: there is no bundle to
    // replace, so the caller must refuse rather than guess at a path.
    expect(installKind("/Users/me/src/kernl/services/kernel/src/core/update", "darwin")).toBe("unknown");
  });

  it("knows a Linux package install owns its files", () => {
    expect(installKind("/opt/kernl/bin", "linux")).toBe("linux-package");
    expect(installKind("/opt/kernl/lib/core/update", "linux")).toBe("linux-package");
  });

  it("treats a packaged Linux copy outside /opt as portable", () => {
    // A tarball unpacked into a home directory has no package manager behind
    // it, so swapping it is nobody else's business.
    expect(installKind("/home/me/kernl/bin", "linux")).toBe("linux-portable");
    expect(installKind("/srv/apps/kernl/bin", "linux")).toBe("linux-portable");
  });

  it("refuses to call a source checkout or a container swappable", () => {
    expect(installKind("/home/me/src/kernl/services/kernel/src/core/update", "linux")).toBe("unknown");
    expect(installKind("/app/dist", "linux")).toBe("unknown");
    expect(installKind("/srv/apps/kernl", "linux")).toBe("unknown");
  });

  it("does not mistake a path that merely mentions opt", () => {
    expect(installKind("/home/me/opt/kernl/bin", "linux")).toBe("linux-portable");
    expect(installKind("/opt/kernl-dev/bin", "linux")).toBe("linux-portable");
  });

  it("recognises the FLAT Windows layout, which has no bin/ at all", () => {
    // The regression this whole file exists for. build-zip.sh and build-msi.sh
    // copy bin/mcp-server.js to the package ROOT, so a Windows install runs
    // from `C:\Program Files\Kernl` — last segment "Kernl". Requiring `bin/`
    // called every Windows install "unknown" and the updater refused before it
    // downloaded anything, on the one platform with no package manager behind
    // it. The marker comes from the caller, which stats the directory.
    expect(installKind("C:\\Program Files\\Kernl", "win32", { packaged: true }))
      .toBe("windows-msi");
    expect(installKind("C:\\Users\\me\\Desktop\\kernl-0.3.0-windows-x64", "win32", { packaged: true }))
      .toBe("windows-dir");
  });

  it("tells an installed Windows copy from an unzipped one", () => {
    // Under Program Files an installer put it there, and msiexec — not a
    // directory move this process has no permission to make — is what upgrades
    // it.
    expect(installKind("C:\\Program Files\\Kernl\\bin", "win32")).toBe("windows-msi");
    expect(installKind("C:\\Program Files (x86)\\Kernl", "win32", { packaged: true }))
      .toBe("windows-msi");
    expect(installKind("D:\\PortableApps\\Kernl\\bin", "win32")).toBe("windows-dir");
  });

  it("still refuses a Windows source checkout", () => {
    // No marker and no bin/: nothing here is a packaged tree, and replacing a
    // developer's working copy with a release archive is the worst possible
    // reading of "update".
    expect(installKind("C:\\Users\\me\\src\\kernl\\services\\kernel\\src", "win32")).toBe("unknown");
    expect(installKind("C:\\Program Files\\Kernl", "win32")).toBe("unknown");
  });

  it("believes the installer's own mark over the path it sits in", () => {
    // INSTALLDIR is user-overridable (WIXUI_INSTALLDIR), so an MSI install can
    // live anywhere — and an unzipped copy can be dropped into Program Files.
    // The registry value product.wxs writes settles it either way.
    expect(installKind("D:\\Apps\\Kernl", "win32", { packaged: true, installerRegistered: true }))
      .toBe("windows-msi");
    expect(installKind("C:\\Program Files\\Kernl", "win32", { packaged: true, installerRegistered: false }))
      .toBe("windows-dir");
  });

  it("falls back to the path only when the mark could not be read", () => {
    // `reg` missing or blocked. Wrong in the safe direction: msiexec refuses
    // cleanly when there is no product, whereas a swap under Program Files
    // fails on permissions after the app has already exited.
    expect(installKind("C:\\Program Files\\Kernl", "win32", { packaged: true }))
      .toBe("windows-msi");
    expect(installKind("D:\\Apps\\Kernl", "win32", { packaged: true })).toBe("windows-dir");
  });

  it("says unknown for a platform with no story", () => {
    expect(installKind("/somewhere", "freebsd")).toBe("unknown");
  });
});

describe("stagingParentFor", () => {
  it("stages beside the install, so the swap stays on one volume", () => {
    // `move` cannot move a DIRECTORY across volumes on Windows, and the system
    // temp dir is on C: while a portable copy is as likely to be on D: or a
    // USB stick. Staged there, the helper waits for the kernel to exit and
    // then fails at the only step that matters.
    expect(stagingParentFor("D:\\PortableApps\\Kernl", "windows-dir")).toBe("D:\\PortableApps");
    expect(stagingParentFor("/home/me/kernl", "linux-portable")).toBe("/home/me");
    expect(stagingParentFor("/Applications/Kernl.app", "macos-app")).toBe("/Applications");
  });

  it("has no opinion when nothing is being swapped", () => {
    // An installer just reads a file, so any readable location will do.
    expect(stagingParentFor("C:\\Program Files\\Kernl", "windows-msi")).toBeNull();
    expect(stagingParentFor("/opt/kernl", "linux-package")).toBeNull();
  });

  it("refuses a path with no parent to speak of", () => {
    expect(stagingParentFor("/kernl", "linux-portable")).toBeNull();
  });
});

describe("installRootFrom", () => {
  it("is the directory above bin/", () => {
    // packaging/stage-payload.sh puts the bundled server in `bin/` with the
    // rest of the tree — dashboard/, assets/ — beside it.
    expect(installRootFrom("/home/me/kernl/bin", "linux-portable")).toBe("/home/me/kernl");
  });

  it("is the module directory itself when the layout is flat", () => {
    expect(installRootFrom("C:\\Program Files\\Kernl", "windows-msi"))
      .toBe("C:\\Program Files\\Kernl");
    expect(installRootFrom("D:\\PortableApps\\Kernl", "windows-dir"))
      .toBe("D:\\PortableApps\\Kernl");
  });

  it("keeps the drive letter on Windows", () => {
    expect(installRootFrom("C:\\Program Files\\Kernl\\bin", "windows-dir"))
      .toBe("C:\\Program Files\\Kernl");
  });

  it("refuses rather than guessing when the layout is not one we know", () => {
    // Linux packaged trees always have bin/; a flat path there is something
    // else entirely, and guessing would aim a swap at a stranger's directory.
    expect(installRootFrom("/home/me/kernl/src/core", "linux-portable")).toBeNull();
    expect(installRootFrom("/bin", "linux-portable")).toBeNull();
    // macOS resolves its own bundle; this function has no business guessing it.
    expect(installRootFrom("/Applications/Kernl.app/Contents/Resources", "macos-app")).toBeNull();
  });
});

describe("who may do what", () => {
  it("swaps a directory only where nothing else owns it", () => {
    expect(isSwappable("macos-app")).toBe(true);
    expect(isSwappable("windows-dir")).toBe(true);
    expect(isSwappable("linux-portable")).toBe(true);
    expect(isSwappable("windows-msi")).toBe(false);
    expect(isSwappable("linux-package")).toBe(false);
    expect(isSwappable("unknown")).toBe(false);
  });

  it("hands an MSI install back to the installer", () => {
    expect(usesInstaller("windows-msi")).toBe(true);
    expect(usesInstaller("windows-dir")).toBe(false);
    expect(usesInstaller("linux-package")).toBe(false);
  });
});

describe("relaunchCommandFor", () => {
  it("relaunches something executable, not the directory", () => {
    // This was the install ROOT everywhere. Right for `open` on a bundle; on
    // Windows it ran `start "" "C:\Program Files\Kernl"`, which opens
    // Explorer, and on Linux it tried to execute a folder.
    expect(relaunchCommandFor("/Applications/Kernl.app", "macos-app"))
      .toEqual(["open", "/Applications/Kernl.app"]);
    expect(relaunchCommandFor("C:\\Program Files\\Kernl", "windows-dir"))
      .toEqual(["C:\\Program Files\\Kernl\\start.bat"]);
    expect(relaunchCommandFor("C:\\Program Files\\Kernl", "windows-msi"))
      .toEqual(["C:\\Program Files\\Kernl\\start.bat"]);
  });

  it("runs the bundled runtime against the bundled kernel on Linux", () => {
    // The portable tarball ships no launcher: packaging/rpm/files/kernl.sh
    // hardcodes /opt/kernl and only ever reaches the packages.
    expect(relaunchCommandFor("/home/me/kernl", "linux-portable"))
      .toEqual(["/home/me/kernl/bin/bun", "/home/me/kernl/bin/mcp-server.js"]);
  });

  it("has nothing to start for an install it does not manage", () => {
    expect(relaunchCommandFor("/opt/kernl", "linux-package")).toBeNull();
    expect(relaunchCommandFor("/whatever", "unknown")).toBeNull();
  });
});

/**
 * Which artefact this machine needs, and whether it may swap itself at all.
 *
 * Both answers were hard-coded to macOS: `apply.ts` refused every other
 * platform outright, so Windows got "only wired for macOS so far" even though
 * the release already publishes a Windows zip, and Linux got a blanket refusal
 * whether or not a package manager actually owned the files.
 *
 * The rule that shapes this: NEVER fight the package manager. Replacing files
 * under /opt that dpkg or rpm believes it owns produces a machine where the
 * next `apt upgrade` undoes the update — worse than not updating. A portable
 * copy has no such owner and can be swapped like any other.
 */
import { describe, it, expect } from "bun:test";
import { assetFor, installKind, installRootFrom } from "../src/core/update/platform.js";

describe("assetFor", () => {
  it("names the macOS tarball per architecture", () => {
    expect(assetFor("1.2.0", "darwin", "arm64")).toBe("Kernl-1.2.0-arm64-macos.tar.gz");
    expect(assetFor("1.2.0", "darwin", "x64")).toBe("Kernl-1.2.0-x64-macos.tar.gz");
  });

  it("names the Windows zip, not the installer", () => {
    // The .msi is for a fresh install by a human. Swapping a directory needs
    // the plain archive, the same shape the macOS path uses.
    expect(assetFor("1.2.0", "win32", "x64")).toBe("Kernl-1.2.0-windows-x64.zip");
  });

  it("names a portable Linux tarball", () => {
    expect(assetFor("1.2.0", "linux", "x64")).toBe("Kernl-1.2.0-x64-linux.tar.gz");
    expect(assetFor("1.2.0", "linux", "arm64")).toBe("Kernl-1.2.0-arm64-linux.tar.gz");
  });

  it("returns null for a platform the release does not build", () => {
    expect(assetFor("1.2.0", "freebsd", "x64")).toBeNull();
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
    // A staged install runs from `<root>/bin`. A dev tree runs from `src/…`,
    // and replacing somebody's working copy with a release tarball is the
    // worst possible reading of "update".
    expect(installKind("/home/me/src/kernl/services/kernel/src/core/update", "linux")).toBe("unknown");
    expect(installKind("/app/dist", "linux")).toBe("unknown");
    expect(installKind("/srv/apps/kernl", "linux")).toBe("unknown");
  });

  it("does not mistake a path that merely mentions opt", () => {
    expect(installKind("/home/me/opt/kernl/bin", "linux")).toBe("linux-portable");
    expect(installKind("/opt/kernl-dev/bin", "linux")).toBe("linux-portable");
  });

  it("treats a packaged Windows install as a swappable directory", () => {
    expect(installKind("C:\\Program Files\\Kernl\\bin", "win32")).toBe("windows-dir");
    expect(installKind("C:\\Users\\me\\src\\kernl\\src", "win32")).toBe("unknown");
  });

  it("says unknown for a platform with no story", () => {
    expect(installKind("/somewhere", "freebsd")).toBe("unknown");
  });
});

describe("installRootFrom", () => {
  it("is the directory above bin/", () => {
    // packaging/stage-payload.sh puts the bundled server in `bin/` with the
    // rest of the tree — dashboard/, assets/ — beside it.
    expect(installRootFrom("/home/me/kernl/bin", "linux-portable")).toBe("/home/me/kernl");
  });

  it("keeps the drive letter on Windows", () => {
    expect(installRootFrom("C:\\Program Files\\Kernl\\bin", "windows-dir"))
      .toBe("C:\\Program Files\\Kernl");
  });

  it("refuses rather than guessing when the layout is not one we know", () => {
    expect(installRootFrom("/home/me/kernl/src/core", "linux-portable")).toBeNull();
    expect(installRootFrom("/bin", "linux-portable")).toBeNull();
    // macOS resolves its own bundle; this function has no business guessing it.
    expect(installRootFrom("/Applications/Kernl.app/Contents/Resources", "macos-app")).toBeNull();
  });
});

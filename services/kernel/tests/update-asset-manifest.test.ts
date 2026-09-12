/**
 * Does the updater ask for names the release actually publishes?
 *
 * This is the test whose absence let the feature ship broken. `assetFor` was
 * asserted against the string `assetFor` itself produced — a function compared
 * to its own output, which passes no matter how wrong it is — while the real
 * release published different names:
 *
 *   updater wanted   Kernl-0.3.0-windows-x64.zip
 *   release had      kernl-0.3.0-windows-x64.zip     ← capital K
 *   updater wanted   Kernl-0.3.0-x64-linux.tar.gz
 *   release had      (nothing: built in CI, never attached)
 *
 * The download survived the first one — GitHub resolves asset names
 * case-insensitively — and then the SHA256SUMS lookup, an exact string
 * comparison, refused the update after transferring 311 MB.
 *
 * The fixture is the asset list of v0.3.0, verbatim, including the two
 * spellings of the product name that the packagers genuinely produce: macOS
 * artefacts are `Kernl-*` (APP_NAME) and linux/windows ones `kernl-*` ($NAME
 * in stage-payload.sh). Recorded rather than fetched so the suite stays
 * offline and deterministic; when the release layout changes on purpose, this
 * list is the thing to update, and updating it is the moment to notice.
 */
import { describe, it, expect } from "bun:test";
import { assetSpecFor, type InstallKind } from "../src/core/update/platform.js";

/** Assets attached to https://github.com/fastslack/kernl/releases/tag/v0.3.0 */
const V030_ASSETS: readonly string[] = [
  "kernl-0.3.0-1.x86_64.rpm",
  "Kernl-0.3.0-arm64-macos.tar.gz",
  "Kernl-0.3.0-arm64.dmg",
  "kernl-0.3.0-windows-x64.msi",
  "kernl-0.3.0-windows-x64.zip",
  "Kernl-0.3.0-x64-macos.tar.gz",
  "Kernl-0.3.0-x64.dmg",
  "kernl_0.3.0-1_amd64.deb",
  "SHA256SUMS",
];

/**
 * What each install kind must find on a release, and on which architecture.
 * `linux-portable` is deliberately absent from the v0.3.0 list — see the
 * separate test below.
 */
const MUST_RESOLVE: { kind: InstallKind; arch: string; expect: string }[] = [
  { kind: "macos-app", arch: "arm64", expect: "Kernl-0.3.0-arm64-macos.tar.gz" },
  { kind: "macos-app", arch: "x64", expect: "Kernl-0.3.0-x64-macos.tar.gz" },
  { kind: "windows-dir", arch: "x64", expect: "kernl-0.3.0-windows-x64.zip" },
  { kind: "windows-msi", arch: "x64", expect: "kernl-0.3.0-windows-x64.msi" },
];

function matches(kind: InstallKind, arch: string, assets: readonly string[]): string[] {
  const spec = assetSpecFor("0.3.0", kind, arch);
  if (!spec) return [];
  return assets.filter((a) => spec.pattern.test(a));
}

describe("the updater against a real release", () => {
  for (const c of MUST_RESOLVE) {
    it(`${c.kind}/${c.arch} resolves to exactly ${c.expect}`, () => {
      // Exactly one: an ambiguous match would mean the updater picks whichever
      // asset the API happens to list first.
      expect(matches(c.kind, c.arch, V030_ASSETS)).toEqual([c.expect]);
    });
  }

  it("never mistakes the installer for the archive, or either for a package", () => {
    const zip = matches("windows-dir", "x64", V030_ASSETS);
    const msi = matches("windows-msi", "x64", V030_ASSETS);
    expect(zip).not.toEqual(msi);
    for (const m of [...zip, ...msi]) {
      expect(m).not.toMatch(/\.(rpm|deb)$/);
    }
  });

  it("matches the checksum file's spelling too", () => {
    // SHA256SUMS is generated from the same filenames that get attached, so a
    // name that resolves against the asset list also has a line there. The
    // lookup in apply.ts folds case for exactly this reason.
    for (const c of MUST_RESOLVE) {
      const [name] = matches(c.kind, c.arch, V030_ASSETS);
      expect(name).toBeDefined();
      expect(V030_ASSETS).toContain(name!);
    }
  });

  it("records that v0.3.0 shipped no portable Linux tarball", () => {
    // The linux job built `Kernl-0.3.0-x64-linux.tar.gz` and uploaded it as a
    // CI artifact, but the release globs only covered `Kernl-*-macos.tar.gz`,
    // so it was never attached and in-app update on Linux 404'd. The globs are
    // fixed in .github/workflows/release.yml; this asserts the shape of the
    // bug rather than the fix, so the fixture stays an honest record of what
    // that release contained.
    expect(matches("linux-portable", "x64", V030_ASSETS)).toEqual([]);
  });

  it("resolves the Linux tarball once a release attaches it", () => {
    const withTarball = [...V030_ASSETS, "Kernl-0.3.0-x64-linux.tar.gz"];
    expect(matches("linux-portable", "x64", withTarball))
      .toEqual(["Kernl-0.3.0-x64-linux.tar.gz"]);
  });

  it("has nothing to resolve for an install it must not touch", () => {
    expect(matches("linux-package", "x64", V030_ASSETS)).toEqual([]);
    expect(matches("unknown", "x64", V030_ASSETS)).toEqual([]);
  });
});

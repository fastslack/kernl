# Homebrew Cask for Kernl.
#
# Lives here so it is versioned with the thing it installs, but Homebrew reads
# casks from a TAP — a separate repository named `homebrew-<something>`. To
# publish:
#
#   1. Create github.com/fastslack/homebrew-kernl
#   2. Copy this file to Casks/kernl.rb in it
#   3. Users then run:
#        brew install --cask fastslack/kernl/kernl
#        brew upgrade --cask kernl
#
# ── Why bother, when the app has an update button ──────────────────────────
# They serve different people and neither replaces the other. The button is for
# whoever double-clicked a .dmg. This is for the audience Kernl actually has —
# people running an MCP server with a Docker stack, who already have brew and
# already type `brew upgrade` without thinking about it. Asking them to click a
# banner in a web UI is asking them to learn a second habit for no reason.
#
# It also sidesteps the part of the update path most likely to break: Homebrew
# does the download, the checksum check and the replacement itself, so none of
# the helper-script machinery is involved.
#
# ── Keeping this in step ───────────────────────────────────────────────────
# `version` and both `sha256` values change with every release. The sums below
# came from the release API rather than being pasted by hand:
#
#   gh release view v<VERSION> --json assets \
#     -q '.assets[] | select(.name|endswith(".dmg")) | .name + "  " + .digest'
#
# Homebrew refuses to install on a mismatch, so a stale sha here fails loudly
# rather than installing the wrong build — the correct direction to fail.
cask "kernl" do
  arch arm: "arm64", intel: "x64"

  version "0.2.4"
  sha256 arm:   "6916c13046fb909348e601cc9eb29454d047dabb6e90d3e58a929f81f988b829",
         intel: "e5f040db11b73af32d91adccc9a809a986b70493adaea45a3d420b45488f588b"

  url "https://github.com/fastslack/kernl/releases/download/v#{version}/Kernl-#{version}-#{arch}.dmg",
      verified: "github.com/fastslack/kernl/"
  name "Kernl"
  desc "Personal life management server — tasks, media, agents, dashboard"
  homepage "https://lifekernl.com/"

  # Tracks the newest published release so `brew outdated` is accurate without
  # anyone updating this file to notice.
  livecheck do
    url :url
    strategy :github_latest
  end

  # Matches what the .dmg actually contains. Through 0.2.3 that was the
  # versioned build name (`Kernl-0.2.3-arm64.app`) and this line was wrong —
  # a cask naming a bundle the image does not have fails the install outright.
  # From the next release the image carries a plain `Kernl.app`, so that an
  # upgrade replaces the install instead of stacking a second copy beside it.
  # Bump `version` and both sums below in the same commit as the release.
  app "Kernl.app"

  # Subtitles shell out to ffmpeg — every transcription engine extracts its
  # audio with it, including the cloud one — and the .app now bundles its own
  # copy, so strictly this is redundant.
  #
  # Kept as a belt-and-braces until a release actually ships with the bundle:
  # `stage-payload.sh` treats a missing ffmpeg asset as non-fatal, so a release
  # cut before the `ffmpeg-v*` tag exists produces a package that silently
  # falls back to PATH. Drop this line once a tagged release carries
  # Contents/Resources/ffmpeg — it costs cask users a ~100 MB formula they do
  # not otherwise need.
  depends_on formula: "ffmpeg"

  # The app writes here on first run. Removed only on `--zap`, never on a plain
  # uninstall: someone reinstalling should not lose their database, and an
  # uninstall that silently deletes months of data is the kind of surprise that
  # ends trust in a tool.
  zap trash: [
    "~/Library/Application Support/Kernl",
  ]

  caveats do
    <<~EOS
      Kernl is not yet signed by Apple, so macOS blocks the first launch.
      Allow it once under System Settings → Privacy & Security → "Open Anyway".

      Start it from /Applications; the dashboard opens on http://localhost:3086.
    EOS
  end
end

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

  version "0.2.1"
  sha256 arm:   "2d7ee0660f486db99875c33ac7d594d7d911f195fae9a25d8ab477f3f404d876",
         intel: "166234e5e4f4761e80972975df03feb5b5c30006e5fe48e336a5b56e5ca2c51c"

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

  app "Kernl.app"

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

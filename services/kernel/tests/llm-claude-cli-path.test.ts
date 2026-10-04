/**
 * The sign-in command has to name a binary that exists. The kernel image keeps
 * no `claude` on PATH — the agent SDK ships it inside its platform package — so
 * printing a bare `claude` told people to run something that answers "not
 * found", directly under a banner telling them their sign-in was out of date.
 * The .dmg hit the same wall: the lookup only knew linux-x64 paths relative to
 * cwd, and a Mac app runs from the user's data directory.
 */
import { describe, it, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeCliPath, claudeCodeLoginCommand } from "../src/core/llm/claude-code-transition.js";
import { bundledClaudeCli, claudeCliPackages, findClaudeCli } from "../src/sdk/claude-cli.js";

const SDK = "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";
const MAC_RES = "/Applications/Kernl.app/Contents/Resources/node_modules";

describe("claudeCliPackages", () => {
  it("names the Mac package for the running arch", () => {
    expect(claudeCliPackages("darwin", "arm64")).toEqual(["@anthropic-ai/claude-agent-sdk-darwin-arm64"]);
    expect(claudeCliPackages("darwin", "x64")).toEqual(["@anthropic-ai/claude-agent-sdk-darwin-x64"]);
  });

  it("tries glibc before musl on Linux", () => {
    expect(claudeCliPackages("linux", "x64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64",
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
    ]);
  });
});

describe("bundledClaudeCli", () => {
  it("follows the module walk into the .app payload, not cwd", () => {
    const pkgDir = `${MAC_RES}/@anthropic-ai/claude-agent-sdk-darwin-arm64`;
    const found = bundledClaudeCli({
      platform: "darwin",
      arch: "arm64",
      resolvePackage: (pkg) => (pkg.endsWith("darwin-arm64") ? pkgDir : null),
      exists: (p) => p === `${pkgDir}/claude`,
    });
    expect(found).toBe(`${pkgDir}/claude`);
  });

  it("still finds the Docker binary under /app", () => {
    const found = bundledClaudeCli({
      platform: "linux",
      arch: "x64",
      resolvePackage: () => null,
      exists: (p) => p === `/app/${SDK}`,
    });
    expect(found).toBe(`/app/${SDK}`);
  });

  it("returns null when the payload has no CLI", () => {
    expect(bundledClaudeCli({ platform: "darwin", arch: "arm64", resolvePackage: () => null, exists: () => false })).toBeNull();
  });

  it("resolves the real platform package from this checkout", () => {
    // services/kernel has the linux-x64 package installed for the Docker image.
    if (process.platform !== "linux" || process.arch !== "x64") return;
    expect(bundledClaudeCli()).toMatch(/claude-agent-sdk-linux-x64(-musl)?\/claude$/);
  });
});

describe("findClaudeCli", () => {
  const none = () => null;

  it("prefers a CLI on PATH over the bundled one", () => {
    const found = findClaudeCli({
      env: { PATH: "/opt/bin" },
      platform: "linux",
      exists: (p) => p === "/opt/bin/claude",
      bundled: () => "/payload/claude",
    });
    expect(found).toBe("/opt/bin/claude");
  });

  it("finds ~/.local/bin even when a Finder-launched app has no shell PATH", () => {
    const local = join(homedir(), ".local/bin/claude");
    const found = findClaudeCli({
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      exists: (p) => p === local,
      bundled: none,
    });
    expect(found).toBe(local);
  });

  it("falls back to the CLI bundled with Kernl", () => {
    const found = findClaudeCli({ env: { PATH: "/usr/bin" }, platform: "darwin", exists: () => false, bundled: () => "/payload/claude" });
    expect(found).toBe("/payload/claude");
  });

  it("honours an explicit override first", () => {
    const found = findClaudeCli({
      override: "/custom/claude",
      env: { PATH: "/opt/bin" },
      platform: "linux",
      exists: () => true,
      bundled: none,
    });
    expect(found).toBe("/custom/claude");
  });

  it("returns null when there is nothing anywhere", () => {
    expect(findClaudeCli({ env: { PATH: "" }, platform: "linux", exists: () => false, bundled: none })).toBeNull();
  });
});

describe("claudeCliPath", () => {
  it("returns what the shared lookup found", () => {
    expect(claudeCliPath(() => `/app/${SDK}`)).toBe(`/app/${SDK}`);
  });

  it("falls back to a bare claude only when nothing is found", () => {
    expect(claudeCliPath(() => null)).toBe("claude");
  });
});

describe("claudeCodeLoginCommand", () => {
  it("wraps the real path in docker exec inside a container", () => {
    const cmd = claudeCodeLoginCommand({ XDG_CONFIG_HOME: "/app/data/xdg" }, true, `/app/${SDK}`);
    expect(cmd).toBe(
      `docker compose exec kernel sh -c 'CLAUDE_CONFIG_DIR="/app/data/xdg/kernl/claude" /app/${SDK}'`,
    );
    expect(cmd).not.toMatch(/ claude'$/);
  });

  it("stays a plain command outside a container", () => {
    const cmd = claudeCodeLoginCommand({ XDG_CONFIG_HOME: "/home/u/.config" }, false, "claude");
    expect(cmd).toBe('CLAUDE_CONFIG_DIR="/home/u/.config/kernl/claude" claude');
  });

  it("quotes a bundled path that contains spaces", () => {
    const cli = "/Users/s/Kernl 0.4.app/Contents/Resources/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
    const cmd = claudeCodeLoginCommand({ XDG_CONFIG_HOME: "/Users/s/.config" }, false, cli);
    expect(cmd).toBe(`CLAUDE_CONFIG_DIR="/Users/s/.config/kernl/claude" "${cli}"`);
  });
});

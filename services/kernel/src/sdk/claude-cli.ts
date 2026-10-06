/**
 * Where the `claude` CLI is — one answer for the whole kernel.
 *
 * Three places used to resolve it on their own: the sign-in command the
 * dashboard prints, the chat provider and the agents executor. Each carried a
 * hardcoded `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`
 * relative to `process.cwd()`, which is right in Docker (/app) and in dev, and
 * wrong in every native package: the launchers chdir into the user's data
 * directory, and a Mac has no linux-x64 binary anyway. On the .dmg nothing
 * matched, the dialog printed a bare `claude`, and the user's terminal answered
 * "command not found" — the subscription could not be connected at all.
 *
 * Sign-in and runtime must also agree on the binary. On macOS the CLI keeps
 * its OAuth credential in the Keychain, and an item created by one executable
 * is not silently readable by another.
 */

import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findOnPath } from "./fs-paths.js";

/**
 * The agent SDK's per-platform packages that carry a native CLI, most
 * preferred first. On Linux glibc goes before musl: Bun on glibc can detect
 * musl and the SDK then picks a binary that does not run.
 */
export function claudeCliPackages(
  platform: string = process.platform,
  arch: string = process.arch,
): string[] {
  const base = "@anthropic-ai/claude-agent-sdk";
  if (platform === "linux") return [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`];
  if (platform === "darwin" || platform === "win32") return [`${base}-${platform}-${arch}`];
  return [];
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The CLI that ships inside Kernl, through the agent SDK's platform package.
 *
 * Resolved with Node's module walk from this file, so it follows the payload
 * wherever it was unpacked: the .app's Resources/node_modules, /app in Docker,
 * services/kernel in dev, and — for a materialized extension — the
 * `<data>/extensions/node_modules` link back into the payload. cwd and /app are
 * kept as a last resort for layouts the walk does not reach.
 */
export function bundledClaudeCli(
  opts: {
    from?: string;
    platform?: string;
    arch?: string;
    exists?: (p: string) => boolean;
    resolvePackage?: (pkg: string) => string | null;
  } = {},
): string | null {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? isFile;
  const resolvePackage = opts.resolvePackage ?? ((pkg: string) => {
    try {
      return dirname(createRequire(opts.from ?? import.meta.url).resolve(`${pkg}/package.json`));
    } catch {
      return null;
    }
  });
  const names = platform === "win32" ? ["claude.exe", "claude"] : ["claude"];

  for (const pkg of claudeCliPackages(platform, opts.arch)) {
    const dirs = [
      resolvePackage(pkg),
      resolve(process.cwd(), "node_modules", pkg),
      platform === "win32" ? null : `/app/node_modules/${pkg}`,
    ];
    for (const dir of dirs) {
      if (!dir) continue;
      for (const name of names) {
        const full = join(dir, name);
        if (exists(full)) return full;
      }
    }
  }
  return null;
}

/**
 * The binary to run, or null when there is none. Order:
 *   explicit override ($CLAUDE_CODE_PATH) → PATH → $HOST_CLAUDE_CLI (the host
 *   CLI bind-mounted into a container) → the official installers' locations →
 *   the CLI bundled with Kernl.
 *
 * An install the user made wins over the bundled one, so a Kernl that runs
 * beside a logged-in CLI keeps using it. The fixed locations matter on macOS:
 * a .app launched from Finder does not inherit the shell PATH, so
 * ~/.local/bin is invisible to the PATH scan.
 */
export function findClaudeCli(
  opts: {
    override?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string;
    exists?: (p: string) => boolean;
    bundled?: () => string | null;
  } = {},
): string | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const isWindows = platform === "win32";

  const override = opts.override || env.CLAUDE_CODE_PATH;
  if (override && exists(override)) return override;

  // On Windows only claude.exe qualifies: the SDK spawns the path directly, and
  // an npm `claude.cmd` shim cannot be spawned without a shell.
  const onPath = findOnPath(isWindows ? "claude.exe" : "claude", {
    env,
    platform: platform as NodeJS.Platform,
    ...(opts.exists ? { exists: opts.exists } : {}),
  });
  if (onPath) return onPath;

  const hostCli = env.HOST_CLAUDE_CLI;
  if (hostCli && exists(hostCli)) return hostCli;

  // homedir(), not $HOME: Windows has no HOME.
  const home = homedir();
  const candidates = isWindows
    ? [
        resolve(home, ".local", "bin", "claude.exe"),
        // npm global install. Its claude.cmd shim only wraps this script,
        // which the SDK can run directly with the kernel's own runtime.
        resolve(env.APPDATA ?? resolve(home, "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
      ]
    : [
        resolve(home, ".local/bin/claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
      ];
  for (const c of candidates) {
    if (exists(c)) return c;
  }

  return (opts.bundled ?? (() => bundledClaudeCli({ platform })))();
}

/**
 * Where the CLI keeps its credentials.
 *
 * Same XDG rule as the license (see license/service.ts): honour
 * XDG_CONFIG_HOME when the launcher sets it, else ~/.config. Under Docker that
 * resolves inside the data volume, so the login outlives the container; on a
 * native install it is the user's own config directory, so it outlives an
 * upgrade. No per-platform branch is needed for either.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : resolve(homedir(), ".config");
  return resolve(base, "kernl", "claude");
}

/**
 * Environment additions for every `claude` child process.
 *
 * `oauthToken` is the escape hatch for hosts where the interactive flow cannot
 * run at all (no PTY — Windows without ConPTY, locked-down sandboxes): the
 * operator pastes a token minted by `claude setup-token` anywhere else and it
 * is injected here instead. Verified against the CLI: with the variable set,
 * `auth status` reports authMethod "oauth_token".
 */
export function claudeAuthEnv(opts: { oauthToken?: string; env?: NodeJS.ProcessEnv } = {}): Record<string, string> {
  const out: Record<string, string> = {
    CLAUDE_CONFIG_DIR: claudeConfigDir(opts.env ?? process.env),
  };
  // Fall back to the environment. The adapter that makes real calls is built
  // with no config (client.ts constructs it zero-arg), so a token that lived
  // only in the provider registry never reached it: the dialog verified fine
  // and every actual request still failed "Not logged in".
  const token = (opts.oauthToken ?? (opts.env ?? process.env).CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  if (token) out.CLAUDE_CODE_OAUTH_TOKEN = token;
  return out;
}

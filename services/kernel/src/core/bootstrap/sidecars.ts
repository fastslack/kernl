/**
 * Stage: bundled sidecars for binary installs.
 *
 * Docker runs mtw-server and the Go whatsapp-bridge as their own services. A
 * binary install (Linux portable tarball, macOS .app, Windows zip) has no
 * compose file, so those two binaries ship inside the payload
 * (packaging/stage-payload.sh, section 2d) and the kernel runs them as
 * supervised children. They talk over unix sockets under the data dir, or
 * per-install named pipes on Windows (see sidecarEndpoints), and stop at
 * stdin EOF (MTW_EXIT_ON_STDIN_EOF=1) — the graceful stop Windows lacks.
 *
 * Active only when the launcher says this is a binary install
 * (KERNL_BINARY_INSTALL=1), and only when both binaries are actually there —
 * a package built from a release without the assets falls back to whatever
 * the user runs themselves, exactly as before.
 *
 * Runs before loadConfig: the config object reads RUST_BRIDGE_SOCKET when it
 * is built, and the mtw stage reads KERNEL_URL. The launchers export the same
 * values; the `??=` here covers a kernel started some other way and never
 * overrides what the user set.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import { SidecarSupervisor, reapOrphan } from "../sidecars/supervisor.js";

/**
 * What the bridge inherits from the kernel: no API keys, nothing else. On
 * Windows also the system variables Go's resolver, crypto and temp dirs need
 * (without SystemRoot, DNS and TLS fail).
 */
export function bridgeEnvAllowlist(platform: NodeJS.Platform): string[] {
  const base = ["PATH", "HOME", "TMPDIR", "TZ", "LANG"];
  if (platform !== "win32") return base;
  return [
    ...base,
    "SystemRoot", "SYSTEMROOT", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "COMSPEC", "PATHEXT",
  ];
}

/**
 * Where the two links live: unix sockets under the data dir, or per-install
 * named pipes on Windows. `<id>` keeps installs apart (derived from the data
 * dir, so it is guessable); `nonce` is a per-boot random suffix (shared by
 * both names in one boot) that makes squatting the pipe name useless — a
 * local attacker who precomputes `<id>` still cannot predict the nonce.
 */
export function sidecarEndpoints(
  platform: NodeJS.Platform,
  dataDir: string,
  nonce?: string,
): { whatsapp: string; rust: string } {
  if (platform === "win32") {
    const id = createHash("sha256").update(path.win32.resolve(dataDir).toLowerCase()).digest("hex").slice(0, 10);
    const suffix = nonce ?? randomBytes(6).toString("hex");
    return { whatsapp: `\\\\.\\pipe\\kernl-${id}-${suffix}-whatsapp`, rust: `\\\\.\\pipe\\kernl-${id}-${suffix}-rust` };
  }
  const runDir = path.join(dataDir, "run");
  return { whatsapp: path.join(runDir, "whatsapp.sock"), rust: path.join(runDir, "mtw-rust.sock") };
}

/** TOML basic-string escaping. */
const tomlString = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export async function startSidecars(opts: {
  appDir: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /**
   * Test seam: let the orphan check recognise shell-script fake binaries by
   * argv[1]. Never set in production.
   */
  matchScriptArgv?: boolean;
  /** Test seam: how both children are spawned. Defaults to Bun.spawn. */
  spawnFn?: typeof Bun.spawn;
}): Promise<SidecarSupervisor[]> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const { appDir, dataDir } = opts;

  if (env.KERNL_BINARY_INSTALL !== "1") return [];

  const exe = platform === "win32" ? ".exe" : "";
  const serverBin = path.join(appDir, "bin", "mtw-server", `mtw-server${exe}`);
  const bridgeBin = path.join(appDir, "bin", "whatsapp-bridge", `whatsapp-bridge${exe}`);
  // stage-payload puts the template in bin/ (every package format ships
  // bin/); payloads staged before that have it at the root.
  const binTemplate = path.join(appDir, "bin", "mtw.binary.toml");
  const template = existsSync(binTemplate) ? binTemplate : path.join(appDir, "mtw.binary.toml");
  for (const f of [serverBin, bridgeBin, template]) {
    if (!existsSync(f)) {
      log.info(`sidecars: ${path.relative(appDir, f)} not bundled — not starting mtw-server/whatsapp-bridge`);
      return [];
    }
  }

  const runDir = path.join(dataDir, "run");
  const mtwDir = path.join(dataDir, "mtw");
  const waDir = path.join(dataDir, "whatsapp");
  for (const d of [runDir, mtwDir, waDir, path.join(dataDir, "torrents")]) {
    mkdirSync(d, { recursive: true });
  }

  // runDir stays on every platform: the pidfiles live there. The nonce is
  // generated once per boot (not inside sidecarEndpoints) so the two pipe
  // names it produces share the same random suffix.
  const nonce = platform === "win32" ? randomBytes(6).toString("hex") : undefined;
  const { whatsapp: whatsappSock, rust: rustSock } = sidecarEndpoints(platform, dataDir, nonce);

  // TOML basic-string escaping: a data dir with a backslash or a quote in it
  // (every Windows path, every named pipe) would otherwise produce a config
  // mtw-server refuses to parse. Templates that still spell the socket as
  // {{DATA_DIR}}/run/whatsapp.sock keep working on Unix.
  const rendered = readFileSync(template, "utf8")
    .replaceAll("{{WHATSAPP_SOCKET}}", tomlString(whatsappSock))
    .replaceAll("{{DATA_DIR}}", tomlString(dataDir));
  writeFileSync(path.join(mtwDir, "mtw.toml"), rendered);

  env.KERNEL_URL ??= "ws://127.0.0.1:7741/ws";
  env.RUST_BRIDGE_SOCKET ??= rustSock;

  const bridgePid = path.join(runDir, "whatsapp-bridge.pid");
  const serverPid = path.join(runDir, "mtw-server.pid");
  // Children a SIGKILLed kernel left behind would hold the port and the
  // WhatsApp session; stop them before starting fresh ones.
  const reap = { matchScriptArgv: opts.matchScriptArgv === true };
  await Promise.all([reapOrphan(serverPid, serverBin, reap), reapOrphan(bridgePid, bridgeBin, reap)]);

  const spawnFn = opts.spawnFn ?? Bun.spawn;
  const bridge = new SidecarSupervisor({
    name: "whatsapp-bridge",
    command: bridgeBin,
    cwd: waDir,
    pidFile: bridgePid,
    inheritEnv: bridgeEnvAllowlist(platform),
    stdinShutdown: true,
    env: {
      MTW_WHATSAPP_SOCKET: whatsappSock,
      MTW_WHATSAPP_DB: path.join(waDir, "session.db"),
      MTW_EXIT_ON_STDIN_EOF: "1",
    },
  }, spawnFn);
  const server = new SidecarSupervisor({
    name: "mtw-server",
    command: serverBin,
    cwd: mtwDir,
    pidFile: serverPid,
    stdinShutdown: true,
    env: {
      MTW_EXIT_ON_STDIN_EOF: "1",
      // Pinned: an inherited MTW_HOST=0.0.0.0 would expose the bus on a desktop.
      MTW_HOST: "127.0.0.1",
      MTW_PORT: "7741",
      RUST_BRIDGE_SOCKET: env.RUST_BRIDGE_SOCKET,
      // The torrent module reads its storage path from env only, never from
      // mtw.toml; without this it writes under ~/.local/share/mtwrequest.
      TORRENT_STORAGE_PATH: env.TORRENT_STORAGE_PATH ?? path.join(dataDir, "torrents"),
    },
  }, spawnFn);

  bridge.start();
  server.start();
  // A clean shutdown stops both through the shutdown stage; this covers the
  // exits that skip it (a crash in a later bootstrap stage, process.exit).
  process.once("exit", () => {
    server.killNow();
    bridge.killNow();
  });
  log.info("sidecars: whatsapp-bridge and mtw-server started");
  return [bridge, server];
}

/**
 * Where the payload and the per-user data live, for the bootstrap call.
 *
 * The launchers export both. Without them: the vendored bun sits in
 * <app>/bin/bun on Linux and <app>/bun in the macOS Resources folder, and the
 * launchers cd into the data dir before exec, so cwd is the data dir.
 */
export function resolveSidecarDirs(env: NodeJS.ProcessEnv = process.env): { appDir: string; dataDir: string } {
  let appDir = env.KERNL_APP_DIR;
  if (!appDir) {
    const exeDir = path.dirname(process.execPath);
    appDir = path.basename(exeDir) === "bin" ? path.dirname(exeDir) : exeDir;
  }
  return { appDir, dataDir: env.KERNL_DATA_DIR ?? process.cwd() };
}

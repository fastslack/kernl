/**
 * Stage: bundled sidecars for binary installs.
 *
 * Docker runs mtw-server and the Go whatsapp-bridge as their own services. A
 * binary install (Linux portable tarball, macOS .app) has no compose file, so
 * those two binaries ship inside the payload (packaging/stage-payload.sh,
 * section 2d) and the kernel runs them as supervised children.
 *
 * Active only when the launcher says this is a binary install
 * (KERNL_BINARY_INSTALL=1), never on Windows (no bundle, and no unix sockets
 * where these binaries expect them), and only when both binaries are actually
 * there — a package built from a release without the assets falls back to
 * whatever the user runs themselves, exactly as before.
 *
 * Runs before loadConfig: the config object reads RUST_BRIDGE_SOCKET when it
 * is built, and the mtw stage reads KERNEL_URL. The launchers export the same
 * values; the `??=` here covers a kernel started some other way and never
 * overrides what the user set.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import { SidecarSupervisor, reapOrphan } from "../sidecars/supervisor.js";

/** What the bridge inherits from the kernel: no API keys, nothing else. */
const BRIDGE_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "TZ", "LANG"] as const;

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
}): Promise<SidecarSupervisor[]> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const { appDir, dataDir } = opts;

  if (env.KERNL_BINARY_INSTALL !== "1" || platform === "win32") return [];

  const serverBin = path.join(appDir, "bin", "mtw-server", "mtw-server");
  const bridgeBin = path.join(appDir, "bin", "whatsapp-bridge", "whatsapp-bridge");
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

  // TOML basic-string escaping: a data dir with a backslash or a quote in it
  // would otherwise produce a config mtw-server refuses to parse.
  const tomlDataDir = dataDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const rendered = readFileSync(template, "utf8").replaceAll("{{DATA_DIR}}", tomlDataDir);
  writeFileSync(path.join(mtwDir, "mtw.toml"), rendered);

  const whatsappSock = path.join(runDir, "whatsapp.sock");
  const rustSock = path.join(runDir, "mtw-rust.sock");

  env.KERNEL_URL ??= "ws://127.0.0.1:7741/ws";
  env.RUST_BRIDGE_SOCKET ??= rustSock;

  const bridgePid = path.join(runDir, "whatsapp-bridge.pid");
  const serverPid = path.join(runDir, "mtw-server.pid");
  // Children a SIGKILLed kernel left behind would hold the port and the
  // WhatsApp session; stop them before starting fresh ones.
  const reap = { matchScriptArgv: opts.matchScriptArgv === true };
  await Promise.all([reapOrphan(serverPid, serverBin, reap), reapOrphan(bridgePid, bridgeBin, reap)]);

  const bridge = new SidecarSupervisor({
    name: "whatsapp-bridge",
    command: bridgeBin,
    cwd: waDir,
    pidFile: bridgePid,
    inheritEnv: BRIDGE_ENV_ALLOWLIST,
    env: {
      MTW_WHATSAPP_SOCKET: whatsappSock,
      MTW_WHATSAPP_DB: path.join(waDir, "session.db"),
    },
  });
  const server = new SidecarSupervisor({
    name: "mtw-server",
    command: serverBin,
    cwd: mtwDir,
    pidFile: serverPid,
    env: {
      // Pinned: an inherited MTW_HOST=0.0.0.0 would expose the bus on a desktop.
      MTW_HOST: "127.0.0.1",
      MTW_PORT: "7741",
      RUST_BRIDGE_SOCKET: env.RUST_BRIDGE_SOCKET,
      // The torrent module reads its storage path from env only, never from
      // mtw.toml; without this it writes under ~/.local/share/mtwrequest.
      TORRENT_STORAGE_PATH: env.TORRENT_STORAGE_PATH ?? path.join(dataDir, "torrents"),
    },
  });

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

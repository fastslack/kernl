import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SidecarSupervisor, reapOrphan, windowsImageMatches } from "../src/core/sidecars/supervisor.js";
import { bridgeEnvAllowlist, sidecarEndpoints, startSidecars } from "../src/core/bootstrap/sidecars.js";

const TEMPLATE = path.resolve(import.meta.dir, "../../../packaging/mtw.binary.toml");

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sidecar-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function script(file: string, body: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** The pid of a process that has already exited (a dead kernel). */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
  return p.pid;
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await Bun.sleep(20);
  }
  return cond();
}

describe("SidecarSupervisor", () => {
  it("restarts a crashing sidecar with backoff", async () => {
    const dir = tmp();
    const counter = path.join(dir, "spawns.txt");
    const cmd = script(path.join(dir, "crash.sh"), `date +%s%N >> "${counter}"\nexit 1`);
    const sup = new SidecarSupervisor({ name: "crash", command: cmd, minBackoffMs: 50, maxBackoffMs: 200 });
    cleanup.push(() => sup.stop());
    sup.start();
    await Bun.sleep(600);
    await sup.stop();

    expect(sup.restarts).toBeGreaterThanOrEqual(2);
    const stamps = readFileSync(counter, "utf8").trim().split("\n").map(s => Number(BigInt(s) / 1_000_000n));
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    // 50 → 100 → 200: each wait is at least the backoff, and the second is longer than the first.
    expect(gaps[0]).toBeGreaterThanOrEqual(45);
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
  });

  it("stop terminates a long-running sidecar", async () => {
    const dir = tmp();
    const cmd = script(path.join(dir, "loop.sh"), `trap 'exit 0' TERM\nwhile true; do sleep 0.1; done`);
    const sup = new SidecarSupervisor({ name: "loop", command: cmd });
    cleanup.push(() => sup.stop());
    sup.start();
    expect(await waitFor(() => sup.running)).toBe(true);
    await Bun.sleep(100);
    const t0 = Date.now();
    await sup.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(sup.running).toBe(false);
    expect(sup.restarts).toBe(0);
  });
});

/**
 * The tail of every fake bundled binary: like the real ones, exit at stdin EOF
 * when MTW_EXIT_ON_STDIN_EOF=1, otherwise run until SIGTERM.
 */
const FAKE_LOOP =
  `if [ "$MTW_EXIT_ON_STDIN_EOF" = 1 ]; then cat >/dev/null; exit 0; fi\n` +
  `trap 'exit 0' TERM\nwhile true; do sleep 0.1; done`;

function fakeApp(opts: { bridge?: boolean; server?: boolean; templateAtRoot?: boolean } = {}) {
  const appDir = tmp();
  const dataDir = tmp();
  mkdirSync(path.join(appDir, "bin"), { recursive: true });
  copyFileSync(TEMPLATE, path.join(appDir, opts.templateAtRoot ? "mtw.binary.toml" : "bin/mtw.binary.toml"));
  if (opts.bridge !== false) {
    script(
      path.join(appDir, "bin/whatsapp-bridge/whatsapp-bridge"),
      `echo "$MTW_WHATSAPP_SOCKET|$MTW_WHATSAPP_DB" > "${dataDir}/bridge.env"\n` +
        `echo "\${SIDECAR_TEST_SECRET:-none}|\${PATH:+path}" > "${dataDir}/bridge.inherit"\n` +
        FAKE_LOOP,
    );
  }
  if (opts.server !== false) {
    script(
      path.join(appDir, "bin/mtw-server/mtw-server"),
      `echo "$RUST_BRIDGE_SOCKET|$(pwd)" > "${dataDir}/server.env"\n` +
        `echo "$MTW_HOST|$MTW_PORT|\${SIDECAR_TEST_SECRET:-none}" > "${dataDir}/server.inherit"\n` +
        FAKE_LOOP,
    );
  }
  return { appDir, dataDir };
}

describe("startSidecars", () => {
  it("startSidecars is a no-op without the flag or binaries", async () => {
    const full = fakeApp();
    expect(await startSidecars({ ...full, env: {}, platform: "linux" })).toEqual([]);
    // win32 looks for the .exe pair, which this bundle does not have.
    expect(await startSidecars({ ...full, env: { KERNL_BINARY_INSTALL: "1" }, platform: "win32" })).toEqual([]);
    const noBridge = fakeApp({ bridge: false });
    expect(await startSidecars({ ...noBridge, env: { KERNL_BINARY_INSTALL: "1" }, platform: "linux" })).toEqual([]);
    const noServer = fakeApp({ server: false });
    expect(await startSidecars({ ...noServer, env: { KERNL_BINARY_INSTALL: "1" }, platform: "linux" })).toEqual([]);
    expect(existsSync(path.join(full.dataDir, "mtw/mtw.toml"))).toBe(false);
  });

  it("holds mtw-server back until the kernel's database is ready", async () => {
    const { appDir, dataDir } = fakeApp();
    let dbReady!: () => void;
    const serverGate = new Promise<void>(resolve => { dbReady = resolve; });
    const sups = await startSidecars({ appDir, dataDir, env: { KERNL_BINARY_INSTALL: "1" }, platform: "linux", serverGate });
    cleanup.push(async () => { await Promise.all(sups.map(s => s.stop())); });
    expect(sups.length).toBe(2);

    // The bridge does not touch kernel.db, so it starts right away.
    expect(await waitFor(() => existsSync(path.join(dataDir, "bridge.env")))).toBe(true);
    expect(await waitFor(() => existsSync(path.join(dataDir, "server.env")), 800)).toBe(false);

    dbReady();
    expect(await waitFor(() => existsSync(path.join(dataDir, "server.env")))).toBe(true);
  });

  it("startSidecars renders mtw.toml and starts both", async () => {
    const { appDir, dataDir } = fakeApp();
    const env: NodeJS.ProcessEnv = { KERNL_BINARY_INSTALL: "1" };
    const sups = await startSidecars({ appDir, dataDir, env, platform: "linux" });
    cleanup.push(async () => { await Promise.all(sups.map(s => s.stop())); });
    expect(sups.length).toBe(2);

    const toml = readFileSync(path.join(dataDir, "mtw/mtw.toml"), "utf8");
    expect(toml).toContain(`${dataDir}/run/whatsapp.sock`);
    expect(toml).toContain(`${dataDir}/data/kernel.db`);
    expect(toml).not.toContain("{{DATA_DIR}}");

    const bridgeEnv = path.join(dataDir, "bridge.env");
    const serverEnv = path.join(dataDir, "server.env");
    expect(await waitFor(() => existsSync(bridgeEnv) && existsSync(serverEnv))).toBe(true);
    expect(readFileSync(bridgeEnv, "utf8").trim()).toBe(`${dataDir}/run/whatsapp.sock|${dataDir}/whatsapp/session.db`);
    expect(readFileSync(serverEnv, "utf8").trim()).toBe(`${dataDir}/run/mtw-rust.sock|${dataDir}/mtw`);

    expect(env.KERNEL_URL).toBe("ws://127.0.0.1:7741/ws");
    expect(env.RUST_BRIDGE_SOCKET).toBe(`${dataDir}/run/mtw-rust.sock`);

    await Promise.all(sups.map(s => s.stop()));
    expect(sups.every(s => !s.running)).toBe(true);
  });
});

describe("sidecar hardening", () => {
  it("reads a template left at the payload root by an older stage-payload", async () => {
    const { appDir, dataDir } = fakeApp({ templateAtRoot: true });
    const sups = await startSidecars({ appDir, dataDir, env: { KERNL_BINARY_INSTALL: "1" }, platform: "linux" });
    cleanup.push(async () => { await Promise.all(sups.map(s => s.stop())); });
    expect(sups.length).toBe(2);
    expect(existsSync(path.join(dataDir, "mtw/mtw.toml"))).toBe(true);
  });

  it("the bridge gets only the env allowlist; mtw-server is pinned to loopback:7741", async () => {
    const { appDir, dataDir } = fakeApp();
    const prev = { secret: process.env.SIDECAR_TEST_SECRET, host: process.env.MTW_HOST };
    process.env.SIDECAR_TEST_SECRET = "sk-test";
    process.env.MTW_HOST = "0.0.0.0";
    cleanup.push(() => {
      if (prev.secret === undefined) delete process.env.SIDECAR_TEST_SECRET; else process.env.SIDECAR_TEST_SECRET = prev.secret;
      if (prev.host === undefined) delete process.env.MTW_HOST; else process.env.MTW_HOST = prev.host;
    });
    const sups = await startSidecars({ appDir, dataDir, env: { KERNL_BINARY_INSTALL: "1" }, platform: "linux" });
    cleanup.push(async () => { await Promise.all(sups.map(s => s.stop())); });
    const b = path.join(dataDir, "bridge.inherit");
    const s = path.join(dataDir, "server.inherit");
    expect(await waitFor(() => existsSync(b) && existsSync(s))).toBe(true);
    expect(readFileSync(b, "utf8").trim()).toBe("none|path");
    // mtw-server still inherits the rest (it reads the LLM keys).
    expect(readFileSync(s, "utf8").trim()).toBe("127.0.0.1|7741|sk-test");
  });

  it("keeps pidfiles while running and removes them on stop", async () => {
    const { appDir, dataDir } = fakeApp();
    const sups = await startSidecars({ appDir, dataDir, env: { KERNL_BINARY_INSTALL: "1" }, platform: "linux" });
    cleanup.push(async () => { await Promise.all(sups.map(s => s.stop())); });
    const pidOf = (n: string) => path.join(dataDir, "run", `${n}.pid`);
    expect(await waitFor(() => existsSync(pidOf("whatsapp-bridge")) && existsSync(pidOf("mtw-server")))).toBe(true);
    const [pid, kernelPid] = readFileSync(pidOf("whatsapp-bridge"), "utf8").trim().split(" ").map(Number);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(kernelPid).toBe(process.pid);
    await Promise.all(sups.map(s => s.stop()));
    expect(existsSync(pidOf("whatsapp-bridge"))).toBe(false);
    expect(existsSync(pidOf("mtw-server"))).toBe(false);
  });

  it("stops an orphan left by a SIGKILLed kernel before starting a new one", async () => {
    const { appDir, dataDir } = fakeApp();
    const bridgeBin = path.join(appDir, "bin/whatsapp-bridge/whatsapp-bridge");
    const orphan = Bun.spawn([bridgeBin], { stdout: "ignore", stderr: "ignore" });
    cleanup.push(() => { try { orphan.kill("SIGKILL"); } catch { /* gone */ } });
    mkdirSync(path.join(dataDir, "run"), { recursive: true });
    const pidFile = path.join(dataDir, "run/whatsapp-bridge.pid");
    writeFileSync(pidFile, `${orphan.pid} ${await deadPid()}\n`);
    await Bun.sleep(100);

    const sups = await startSidecars({
      appDir, dataDir, env: { KERNL_BINARY_INSTALL: "1" }, platform: "linux", matchScriptArgv: true,
    });
    cleanup.push(async () => { await Promise.all(sups.map(s => s.stop())); });
    const exited = await Promise.race([orphan.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    expect(exited).toBe(true);
    const childOf = () => Number(readFileSync(pidFile, "utf8").trim().split(" ")[0]);
    expect(await waitFor(() => existsSync(pidFile) && childOf() !== orphan.pid)).toBe(true);
  });

  it("leaves the children of a kernel that is still running alone", async () => {
    const dir = tmp();
    const bin = script(path.join(dir, "bridge"), `trap 'exit 0' TERM\nwhile true; do sleep 0.1; done`);
    const child = Bun.spawn([bin], { stdout: "ignore", stderr: "ignore" });
    const kernel = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
    cleanup.push(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      try { kernel.kill("SIGKILL"); } catch { /* gone */ }
    });
    await Bun.sleep(150);
    const pidFile = path.join(dir, "b.pid");
    writeFileSync(pidFile, `${child.pid} ${kernel.pid}\n`);
    expect(await reapOrphan(pidFile, bin, { graceMs: 200, matchScriptArgv: true })).toBe(false);
    expect(() => process.kill(child.pid, 0)).not.toThrow();
    expect(existsSync(pidFile)).toBe(true);
  });

  it("without the test seam a script path in argv[1] is not a match", async () => {
    const dir = tmp();
    const bin = script(path.join(dir, "bridge"), `trap 'exit 0' TERM\nwhile true; do sleep 0.1; done`);
    const child = Bun.spawn([bin], { stdout: "ignore", stderr: "ignore" });
    cleanup.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
    await Bun.sleep(100);
    const pidFile = path.join(dir, "b.pid");
    writeFileSync(pidFile, `${child.pid} ${await deadPid()}\n`);
    expect(await reapOrphan(pidFile, bin, { graceMs: 200 })).toBe(false);
    expect(() => process.kill(child.pid, 0)).not.toThrow();
  });

  it("never kills a live pid that runs something else", async () => {
    const dir = tmp();
    const other = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    cleanup.push(() => { try { other.kill("SIGKILL"); } catch { /* gone */ } });
    const pidFile = path.join(dir, "x.pid");
    writeFileSync(pidFile, `${other.pid} ${await deadPid()}\n`);
    expect(await reapOrphan(pidFile, path.join(dir, "bin/whatsapp-bridge"), { graceMs: 200, matchScriptArgv: true })).toBe(false);
    expect(() => process.kill(other.pid, 0)).not.toThrow();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("escalates to SIGKILL when the orphan ignores SIGTERM", async () => {
    const dir = tmp();
    const bin = script(path.join(dir, "stubborn"), `trap '' TERM\nwhile true; do sleep 0.1; done`);
    const orphan = Bun.spawn([bin], { stdout: "ignore", stderr: "ignore" });
    cleanup.push(() => { try { orphan.kill("SIGKILL"); } catch { /* gone */ } });
    await Bun.sleep(100);
    const pidFile = path.join(dir, "s.pid");
    writeFileSync(pidFile, `${orphan.pid} ${await deadPid()}\n`);
    expect(await reapOrphan(pidFile, bin, { graceMs: 300, matchScriptArgv: true })).toBe(true);
    const exited = await Promise.race([orphan.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
    expect(exited).toBe(true);
  });
});

describe("sidecarEndpoints", () => {
  it("keeps the unix socket paths under the data dir off Windows", () => {
    const e = sidecarEndpoints("linux", "/home/u/.local/share/kernl");
    expect(e.whatsapp).toBe("/home/u/.local/share/kernl/run/whatsapp.sock");
    expect(e.rust).toBe("/home/u/.local/share/kernl/run/mtw-rust.sock");
  });

  it("uses per-install named pipes on Windows, with a per-boot random nonce", () => {
    const e = sidecarEndpoints("win32", "C:\\Users\\Ana María\\AppData\\Local\\Kernl\\data");
    expect(e.whatsapp).toMatch(/^\\\\\.\\pipe\\kernl-[0-9a-f]{10}-[0-9a-f]{12}-whatsapp$/);
    expect(e.rust).toMatch(/^\\\\\.\\pipe\\kernl-[0-9a-f]{10}-[0-9a-f]{12}-rust$/);
  });

  it("gives two installs different pipes and one install the same pipe whatever the case (same nonce)", () => {
    const nonce = "deadbeef0001";
    const a = sidecarEndpoints("win32", "C:\\Users\\ana\\AppData\\Local\\Kernl\\data", nonce);
    const b = sidecarEndpoints("win32", "C:\\Users\\beto\\AppData\\Local\\Kernl\\data", nonce);
    const a2 = sidecarEndpoints("win32", "c:\\users\\ANA\\appdata\\local\\kernl\\data", nonce);
    expect(a.whatsapp).not.toBe(b.whatsapp);
    expect(a2.whatsapp).toBe(a.whatsapp);
  });

  it("shares the same nonce between whatsapp and rust in one boot, and differs across boots", () => {
    const dataDir = "C:\\Users\\ana\\AppData\\Local\\Kernl\\data";
    const bootA = sidecarEndpoints("win32", dataDir);
    const bootB = sidecarEndpoints("win32", dataDir);
    const nonceOf = (pipe: string) => pipe.match(/^\\\\\.\\pipe\\kernl-[0-9a-f]{10}-([0-9a-f]{12})-/)?.[1];
    const nonceA = nonceOf(bootA.whatsapp);
    const nonceR = nonceOf(bootA.rust);
    expect(nonceA).toBeTruthy();
    expect(nonceA).toBe(nonceR);
    expect(nonceOf(bootB.whatsapp)).not.toBe(nonceA);
  });

  it("keeps the prefix stable across boots for the same install (Review Focus 4)", () => {
    const dataDir = "C:\\Users\\ana\\AppData\\Local\\Kernl\\data";
    const bootA = sidecarEndpoints("win32", dataDir);
    const bootB = sidecarEndpoints("win32", dataDir);
    const prefixOf = (pipe: string) => pipe.match(/^(\\\\\.\\pipe\\kernl-[0-9a-f]{10})-/)?.[1];
    expect(prefixOf(bootA.whatsapp)).toBe(prefixOf(bootB.whatsapp));
    expect(prefixOf(bootA.rust)).toBe(prefixOf(bootB.rust));
  });
});

describe("windowsImageMatches", () => {
  it("matches the image name tasklist prints for the pid", () => {
    const csv = '"whatsapp-bridge.exe","4242","Console","1","12,345 K"\r\n';
    expect(windowsImageMatches(csv, "C:\\Kernl\\bin\\whatsapp-bridge\\whatsapp-bridge.exe")).toBe(true);
    expect(windowsImageMatches(csv, "C:\\Kernl\\bin\\mtw-server\\mtw-server.exe")).toBe(false);
  });

  it("never matches when tasklist found nothing", () => {
    expect(windowsImageMatches("INFO: No tasks are running which match the specified criteria.\r\n", "x.exe")).toBe(false);
    expect(windowsImageMatches("", "x.exe")).toBe(false);
  });
});

describe("stdin shutdown", () => {
  it("stops a child that exits at stdin EOF without waiting for the kill", async () => {
    // Exits as soon as stdin closes; ignores SIGTERM, so only the EOF can stop it in time.
    const bin = script(path.join(tmp(), "eof-exit"), `trap '' TERM\ncat >/dev/null\nexit 0`);
    const sup = new SidecarSupervisor({ name: "eof", command: bin, stdinShutdown: true });
    cleanup.push(() => sup.stop());
    sup.start();
    await Bun.sleep(100);
    const t0 = Date.now();
    await sup.stop();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(sup.running).toBe(false);
  });

  it("still kills a child that ignores stdin, after the grace period", async () => {
    const bin = script(path.join(tmp(), "ignore-all"), `trap '' TERM\nwhile true; do sleep 0.1; done`);
    const sup = new SidecarSupervisor({ name: "stubborn", command: bin, stdinShutdown: true, killGraceMs: 300 });
    cleanup.push(() => sup.stop());
    sup.start();
    await Bun.sleep(100);
    const t0 = Date.now();
    await sup.stop();
    // The EOF wait was honoured before any signal.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(sup.running).toBe(false);
  }, 10_000);
});

/**
 * A spawn that records argv and env and runs nothing: a .exe does not run
 * here. The fake proc exits on kill() or when its stdin is closed.
 */
function recordingSpawn(spawned: Array<{ cmd: string[]; env: Record<string, string> }>): typeof Bun.spawn {
  let nextPid = 900_000;
  return ((cmd: string[], opts: { env?: Record<string, string> }) => {
    spawned.push({ cmd, env: { ...(opts?.env ?? {}) } });
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    return {
      pid: nextPid++,
      exited,
      kill: () => exit(0),
      stdin: { end: () => exit(0) },
    };
  }) as unknown as typeof Bun.spawn;
}

/**
 * The Windows bundle layout: the .exe pair and the template under bin/. The
 * data dir is as Windows-shaped as a Linux filesystem allows: a space, a
 * non-ASCII letter and a backslash inside a name.
 */
function makeWindowsInstall() {
  const appDir = tmp();
  const dataDir = path.join(tmp(), "Ana María", "AppData\\Local\\Kernl\\data");
  mkdirSync(dataDir, { recursive: true });
  for (const f of ["bin/mtw-server/mtw-server.exe", "bin/whatsapp-bridge/whatsapp-bridge.exe"]) {
    mkdirSync(path.join(appDir, path.dirname(f)), { recursive: true });
    writeFileSync(path.join(appDir, f), "");
  }
  copyFileSync(TEMPLATE, path.join(appDir, "bin/mtw.binary.toml"));
  return { appDir, dataDir };
}

describe("startSidecars on win32", () => {
  it("starts the .exe pair with pipe endpoints, the stdin contract and the Windows env", async () => {
    const { appDir, dataDir } = makeWindowsInstall();
    const spawned: Array<{ cmd: string[]; env: Record<string, string> }> = [];
    const env: NodeJS.ProcessEnv = { KERNL_BINARY_INSTALL: "1" };
    const sups = await startSidecars({ appDir, dataDir, env, platform: "win32", spawnFn: recordingSpawn(spawned) });
    cleanup.push(async () => { await Promise.all(sups.map(s => s.stop())); });
    expect(sups).toHaveLength(2);
    const bridge = spawned.find((s) => s.cmd[0].endsWith("whatsapp-bridge.exe"))!;
    const server = spawned.find((s) => s.cmd[0].endsWith("mtw-server.exe"))!;
    expect(bridge.env.MTW_WHATSAPP_SOCKET).toMatch(/^\\\\\.\\pipe\\kernl-[0-9a-f]{10}-[0-9a-f]{12}-whatsapp$/);
    expect(bridge.env.MTW_EXIT_ON_STDIN_EOF).toBe("1");
    expect(server.env.MTW_EXIT_ON_STDIN_EOF).toBe("1");
    expect(env.RUST_BRIDGE_SOCKET).toMatch(/^\\\\\.\\pipe\\kernl-[0-9a-f]{10}-[0-9a-f]{12}-rust$/);
    expect(server.env.RUST_BRIDGE_SOCKET).toBe(env.RUST_BRIDGE_SOCKET!);
    // Same boot, same nonce on both names.
    const nonceOf = (pipe: string) => pipe.match(/^\\\\\.\\pipe\\kernl-[0-9a-f]{10}-([0-9a-f]{12})-/)?.[1];
    expect(nonceOf(bridge.env.MTW_WHATSAPP_SOCKET)).toBe(nonceOf(env.RUST_BRIDGE_SOCKET!));
    // A Windows endpoint renders into a config mtw-server parses.
    const toml = readFileSync(path.join(dataDir, "mtw", "mtw.toml"), "utf8");
    expect(toml).toContain(`socket = "${bridge.env.MTW_WHATSAPP_SOCKET.replace(/\\/g, "\\\\")}"`);
    expect(toml).not.toContain("{{WHATSAPP_SOCKET}}");
    const parsed = Bun.TOML.parse(toml) as { whatsapp: { socket: string }; store: { path: string } };
    expect(parsed.whatsapp.socket).toBe(bridge.env.MTW_WHATSAPP_SOCKET);
    // The DATA_DIR-derived paths round-trip with the space, the "í" and the backslashes intact.
    expect(dataDir).toContain("Ana María");
    expect(dataDir).toContain("\\");
    expect(parsed.store.path).toBe(`${dataDir}/data/kernel.db`);
    expect(toml).not.toContain("{{DATA_DIR}}");
    for (const s of sups) await s.stop();
    expect(sups.every(s => !s.running)).toBe(true);
  });

  it("lets the bridge inherit the Windows system variables Go needs", () => {
    expect(bridgeEnvAllowlist("win32")).toEqual(expect.arrayContaining(["SystemRoot", "USERPROFILE", "LOCALAPPDATA", "TEMP", "TMP"]));
    expect(bridgeEnvAllowlist("linux")).not.toContain("SystemRoot");
  });
});

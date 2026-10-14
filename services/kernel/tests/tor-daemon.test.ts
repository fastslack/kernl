import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { configMigrations } from "../src/modules/config/migrations/001_config.js";
import { TorDaemon, TOR_SETTING_KEY } from "../src/core/peering/tor-daemon.js";

/**
 * A stand-in for tor: reads HiddenServiceDir from the torrc it is given,
 * publishes a hostname there and reports bootstrap progress the way tor does.
 * `FAKE_TOR_MODE=die` makes it fail early, like a tor that cannot bind.
 */
const FAKE_TOR = `#!/bin/sh
TORRC="$2"
HS=$(grep '^HiddenServiceDir' "$TORRC" | cut -d' ' -f2-)
if [ "$FAKE_TOR_MODE" = "die" ]; then
  echo "Oct 08 [err] Could not bind to 127.0.0.1:9080: Address already in use"
  exit 1
fi
echo "Oct 08 [notice] Bootstrapped 10% (conn_done): Connected to a relay"
mkdir -p "$HS"
echo "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion" > "$HS/hostname"
echo "Oct 08 [notice] Bootstrapped 100% (done): Done"
sleep 30
`;

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe("TorDaemon", () => {
  let db: InstanceType<typeof Database>; let root: string; let bin: string; let changes: number;
  let daemon: TorDaemon | null;
  const make = (over: Partial<ConstructorParameters<typeof TorDaemon>[0]> = {}) => {
    daemon = new TorDaemon({
      sqlite: db as never,
      servicePort: 3090,
      baseDir: root,
      findBinary: () => bin,
      isListening: async () => false,
      onChange: () => { changes++; },
      ...over,
    });
    return daemon;
  };

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db as never, "config", configMigrations);
    root = mkdtempSync(join(tmpdir(), "tor-"));
    bin = join(root, "fake-tor");
    writeFileSync(bin, FAKE_TOR);
    chmodSync(bin, 0o755);
    changes = 0;
    daemon = null;
    delete process.env.KERNEL_TOR;
    delete process.env.FAKE_TOR_MODE;
  });
  afterEach(() => {
    daemon?.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("is off by default and follows KERNEL_TOR until the switch is used", () => {
    expect(make().enabled()).toBe(false);
    process.env.KERNEL_TOR = "1";
    expect(make().enabled()).toBe(true);
  });

  it("the stored switch wins over KERNEL_TOR", async () => {
    process.env.KERNEL_TOR = "1";
    const d = make();
    await d.setEnabled(false);
    expect(d.enabled()).toBe(false);
    const row = db.prepare("SELECT value, type, category FROM app_settings WHERE key = ?").get(TOR_SETTING_KEY) as Record<string, string>;
    expect(row).toEqual({ value: "0", type: "boolean", category: "integrations" });
  });

  it("starts tor, reports the onion once bootstrapped, and tells presence", async () => {
    const d = make();
    const first = await d.setEnabled(true);
    expect(first.state).toBe("starting");
    await until(() => d.status().state === "up");
    const s = d.status();
    expect(s).toMatchObject({ enabled: true, state: "up", progress: 100, external: false });
    expect(s.onion).toMatch(/^http:\/\/[a-z2-7]{56}\.onion$/);
    expect(changes).toBe(1);
    const torrc = readFileSync(join(root, "data/tor/torrc"), "utf-8");
    expect(torrc).toContain("HiddenServicePort 80 127.0.0.1:3090");
    expect(torrc).toContain(`DataDirectory ${join(root, "data/tor/state")}`);
  });

  it("switching off stops tor and withdraws the onion", async () => {
    const d = make();
    await d.setEnabled(true);
    await until(() => d.status().state === "up");
    const off = await d.setEnabled(false);
    expect(off).toMatchObject({ enabled: false, state: "off", onion: "" });
    expect(changes).toBe(2);
  });

  it("says so in a sentence when there is no tor binary", async () => {
    const s = await make({ findBinary: () => null }).setEnabled(true);
    expect(s.state).toBe("missing");
    expect(s.error).toMatch(/no Tor/);
  });

  it("surfaces tor's own last line when it dies", async () => {
    process.env.FAKE_TOR_MODE = "die";
    const d = make();
    await d.setEnabled(true);
    await until(() => d.status().state === "error");
    expect(d.status().error).toMatch(/Could not bind to 127\.0\.0\.1:9080/);
  });

  it("adopts a tor that already listens and never claims to stop it", async () => {
    const hs = join(root, "data/tor/kernl");
    const d = make({ isListening: async () => true });
    // An onion published by that other tor.
    await d.setEnabled(false);
    mkdirSync(hs, { recursive: true });
    writeFileSync(join(hs, "hostname"), "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion\n");
    const s = await d.setEnabled(true);
    expect(s).toMatchObject({ state: "up", external: true });
    expect(existsSync(join(root, "data/tor/torrc"))).toBe(false);
  });
});

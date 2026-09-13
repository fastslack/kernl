/**
 * Restart Kernl from inside Kernl, the way it was started.
 *
 * An extension update lands its files but its code only runs once the kernel
 * starts again, and "restart it yourself" means something different on every
 * platform: start.bat on Windows, `open` on a macOS app, a systemd unit for
 * the rpm/deb, the container's restart policy under Docker. This reuses the
 * update machinery for exactly that — wait for this process to exit, relaunch
 * the same entry point, wait for /api/health — without replacing any file.
 */

import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { log } from "../logger.js";
import { relaunchCommandFor, restartMethodFor } from "./platform.js";
import { restartHelperFor } from "./helper.js";
import { detectInstall, setUpdateExitPlan, system32, updateDataDir, type InstallInfo } from "./install.js";
import { healthUrl, updateProgress } from "./apply.js";

export type RestartOutcome =
  | { ok: true; restarting: true }
  | { ok: false; reason: string };

type SystemdMethod =
  | { kind: "systemd-user"; unit: string }
  | { kind: "systemd-system"; unit: string };

export type RestartPlan =
  | { kind: "container" }
  | { kind: "systemd"; method: SystemdMethod }
  | { kind: "helper"; windows: boolean; relaunch: string[] }
  | { kind: "refuse"; reason: string };

/** Phases during which an update owns the process and will restart it itself. */
const UPDATE_BUSY = new Set(["checking", "downloading", "verifying", "unpacking", "installing", "handoff"]);

const NOT_INSTALLED =
  "This copy of Kernl was not started from an installed package (a source checkout or a custom " +
  "launcher), so it cannot relaunch itself. Stop it and start it again the way you started it.";

/** How this install is restarted. Pure, so every platform is testable here. */
export function planRestart(
  install: InstallInfo,
  opts: { env: Record<string, string | undefined>; cgroup: string; hasLauncher: boolean },
): RestartPlan {
  switch (install.kind) {
    case "docker":
      // compose runs the kernel with `restart: unless-stopped`: leaving is the restart.
      return { kind: "container" };
    case "linux-package": {
      const method = restartMethodFor(opts.env, opts.cgroup);
      if (method.kind !== "relaunch") return { kind: "systemd", method };
      return { kind: "helper", windows: false, relaunch: ["/usr/bin/kernl"] };
    }
    case "unknown":
      return { kind: "refuse", reason: NOT_INSTALLED };
    default: {
      const relaunch = install.target
        ? relaunchCommandFor(install.target, install.kind, { launcher: opts.hasLauncher })
        : null;
      if (!relaunch?.length) return { kind: "refuse", reason: NOT_INSTALLED };
      const windows = install.kind === "windows-dir" || install.kind === "windows-msi";
      return { kind: "helper", windows, relaunch };
    }
  }
}

function readCgroup(): string {
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

/**
 * Arrange the restart. Like applyUpdate, a success means "about to exit": the
 * caller sends its response and then calls exitForUpdate(), which follows the
 * exit plan set here.
 */
export async function restartKernl(): Promise<RestartOutcome> {
  if (UPDATE_BUSY.has(updateProgress().phase)) {
    return { ok: false, reason: "An update is in progress, and it restarts Kernl when it finishes." };
  }

  const install = await detectInstall();
  const plan = planRestart(install, {
    env: process.env,
    cgroup: readCgroup(),
    hasLauncher: !!install.target && existsSync(join(install.target, "kernl")),
  });

  switch (plan.kind) {
    case "refuse":
      return { ok: false, reason: plan.reason };
    case "container":
      setUpdateExitPlan({ kind: "exit" });
      log.info("restart: leaving so the container's restart policy starts Kernl again");
      return { ok: true, restarting: true };
    case "systemd":
      setUpdateExitPlan(plan.method);
      log.info(`restart: handing the restart to systemd (${plan.method.unit})`);
      return { ok: true, restarting: true };
    case "helper": {
      const dir = join(updateDataDir(), "restart");
      await mkdir(dir, { recursive: true });
      const script = join(dir, plan.windows ? "kernl-restart.cmd" : "kernl-restart.sh");
      await writeFile(
        script,
        restartHelperFor(plan.windows, {
          pid: process.pid,
          staged: "",
          target: install.target ?? "",
          backup: "",
          relaunch: plan.relaunch,
          healthUrl: healthUrl(),
        }),
      );
      if (!plan.windows) await chmod(script, 0o755);
      // Detached and fully severed: it has to outlive us.
      const runner = plan.windows
        ? spawn(process.env.ComSpec ?? system32("cmd.exe"), ["/d", "/c", script], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          })
        : spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
      runner.unref();
      setUpdateExitPlan({ kind: "exit", helperPid: runner.pid });
      log.info(`restart: helper ${runner.pid} will relaunch ${plan.relaunch.join(" ")}`);
      return { ok: true, restarting: true };
    }
  }
}

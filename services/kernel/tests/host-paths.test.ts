/**
 * hostPathReachable: whether the kernel can use a host folder, natively and
 * inside a container (decided from /proc/self/mountinfo).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostPathReachable, mountFor, parseMountinfo } from "../src/sdk/host-paths.js";

// Trimmed from a real Dockerized kernel: overlay root, pseudo filesystems, a
// named volume, a read-only bind and a read-write bind nested inside it.
const MOUNTINFO = [
  "2546 1077 0:92 / / rw,relatime - overlay overlay rw,lowerdir=/x,upperdir=/y,workdir=/z",
  "2547 2546 0:243 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
  "2548 2546 0:250 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755",
  "2549 2546 0:251 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro",
  "3244 2546 0:35 /root/var/lib/docker/volumes/k_data/_data /app/data rw,relatime master:1 - btrfs /dev/nvme0n1p3 rw,compress=zstd:1",
  "3390 2546 0:35 /root/srv/labs /srv/labs ro,relatime - btrfs /dev/nvme0n1p3 rw,compress=zstd:1",
  "3391 3390 0:35 /root/srv/labs/work /srv/labs/work rw,relatime - btrfs /dev/nvme0n1p3 rw,compress=zstd:1",
  "3392 2546 0:35 /root/srv/My\\040Projects /srv/My\\040Projects rw,relatime - ext4 /dev/sda1 rw",
  "3393 2546 0:35 /root/srv/locked /srv/locked rw,relatime - ext4 /dev/sda2 ro,errors=remount-ro",
  "",
].join("\n");

const docker = (path: string, requireWritable = false) =>
  hostPathReachable(path, { inContainer: true, mountinfo: MOUNTINFO, requireWritable });

describe("parseMountinfo", () => {
  it("reads mount point, fs type and read-only from both option sets", () => {
    const mounts = parseMountinfo(MOUNTINFO);
    expect(mounts).toHaveLength(9);
    expect(mounts[0]).toEqual({ mountPoint: "/", fsType: "overlay", readOnly: false });
    expect(mounts.find((m) => m.mountPoint === "/app/data")).toEqual({ mountPoint: "/app/data", fsType: "btrfs", readOnly: false });
    expect(mounts.find((m) => m.mountPoint === "/srv/labs")!.readOnly).toBe(true);
    // rw per-mount but ro super options
    expect(mounts.find((m) => m.mountPoint === "/srv/locked")!.readOnly).toBe(true);
  });

  it("decodes octal escapes in the mount point", () => {
    expect(parseMountinfo(MOUNTINFO).some((m) => m.mountPoint === "/srv/My Projects")).toBe(true);
    expect(parseMountinfo("1 0 0:1 / /a\\011b\\134c rw - ext4 /dev/x rw")[0].mountPoint).toBe("/a\tb\\c");
  });

  it("skips malformed lines", () => {
    expect(parseMountinfo("garbage\n1 2 3\n")).toEqual([]);
  });
});

describe("mountFor", () => {
  const mounts = parseMountinfo(MOUNTINFO);
  it("picks the longest mount point that contains the path", () => {
    expect(mountFor("/srv/labs/work/repo", mounts)!.mountPoint).toBe("/srv/labs/work");
    expect(mountFor("/srv/labs/other", mounts)!.mountPoint).toBe("/srv/labs");
    expect(mountFor("/srv/labs", mounts)!.mountPoint).toBe("/srv/labs");
  });
  it("does not match a sibling that shares a prefix", () => {
    expect(mountFor("/srv/labsX/repo", mounts)!.mountPoint).toBe("/");
    expect(mountFor("/app/database", mounts)!.mountPoint).toBe("/");
  });
});

describe("hostPathReachable in a container", () => {
  it("a folder on the container's own root fs is not reachable, with an actionable reason", () => {
    const r = docker("/home/someone/projects/repo");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("Kernl corre en Docker y no ve /home/someone/projects/repo");
      expect(r.reason).toContain("KERNL_PROJECTS_ROOT");
      expect(r.reason).toContain("docker-compose.host.yml");
    }
  });

  it("pseudo and memory filesystems are not host folders", () => {
    expect(docker("/proc/1").ok).toBe(false);
    expect(docker("/dev/shm/x").ok).toBe(false);
  });

  it("a volume and a read-write bind are reachable and writable", () => {
    expect(docker("/app/data/workspaces/x")).toEqual({ ok: true, exists: false, writable: true });
    expect(docker("/srv/labs/work/repo", true)).toMatchObject({ ok: true, writable: true });
    expect(docker("/srv/My Projects/app")).toMatchObject({ ok: true, writable: true });
  });

  it("a read-only bind is reachable but not writable, and refused when writing is required", () => {
    expect(docker("/srv/labs/repo")).toMatchObject({ ok: true, writable: false });
    const r = docker("/srv/labs/repo", true);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("solo en lectura");
      expect(r.reason).toContain("/srv/labs");
    }
    expect(docker("/srv/locked/x", true).ok).toBe(false);
  });

  it("normalizes trailing slashes and dot segments", () => {
    expect(docker("/srv/labs/work/").ok).toBe(true);
    expect(docker("/srv/labs/work/../../x").ok).toBe(false);
  });

  it("refuses relative or empty paths", () => {
    expect(docker("relative/dir").ok).toBe(false);
    expect(docker("").ok).toBe(false);
  });
});

describe("hostPathReachable natively", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kernl-host-paths-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("an existing folder exists and is writable", () => {
    expect(hostPathReachable(dir, { inContainer: false })).toEqual({ ok: true, exists: true, writable: true });
  });

  it("a missing folder under an existing ancestor is reachable but does not exist yet", () => {
    expect(hostPathReachable(join(dir, "a", "b"), { inContainer: false })).toEqual({ ok: true, exists: false, writable: true });
  });

  it("ignores the mount table outside a container", () => {
    mkdirSync(join(dir, "x"));
    expect(hostPathReachable(join(dir, "x"), { inContainer: false, mountinfo: MOUNTINFO }).ok).toBe(true);
  });

  it("refuses a relative path", () => {
    const r = hostPathReachable("rel/dir", { inContainer: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no es una ruta absoluta");
  });
});

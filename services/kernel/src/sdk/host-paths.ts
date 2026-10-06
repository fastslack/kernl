/**
 * Can the kernel actually see a host folder?
 *
 * Offices and agents point at host folders (an office's home_repo_path, an
 * agent's `__cwd_path__`). Run natively, that is a plain existence check. Run
 * in Docker, only the folders bind-mounted from the host are there: anything
 * else either does not exist or — worse — gets created inside the container's
 * own filesystem by a `mkdir`, where it looks fine until the next recreate
 * wipes it, and none of the work ever reaches the host.
 *
 * Inside a container the answer comes from `/proc/self/mountinfo`: the path is
 * reachable when the most specific mount that contains it is a real mount
 * (a bind mount or a Docker volume), not the container's root filesystem or a
 * pseudo/tmpfs mount. Write access comes from the same line's options.
 *
 * Pure: node:fs only, and both the container flag and the mountinfo text can
 * be injected, so every branch is testable on any machine.
 */

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";

export type HostPathCheck =
  | { ok: true; exists: boolean; writable: boolean }
  | { ok: false; reason: string };

export interface HostPathOptions {
  /** Refuse a folder the kernel could see but not write (it will mkdir, git init or seed it). */
  requireWritable?: boolean;
  /** Override container detection (default: `/.dockerenv` exists). */
  inContainer?: boolean;
  /** Override the mount table (default: `/proc/self/mountinfo`). */
  mountinfo?: string;
}

export interface MountEntry {
  /** Where it is mounted inside this mount namespace (field 5, unescaped). */
  mountPoint: string;
  /** Filesystem type (first field after the ` - ` separator). */
  fsType: string;
  /** Read-only per the per-mount options (field 6) or the super options. */
  readOnly: boolean;
}

/**
 * Mounts that live and die with the container: its root filesystem is checked
 * separately (mount point `/`), these are the kernel and runtime pseudo/memory
 * filesystems. A folder under one of them is not a host folder either.
 */
const NON_HOST_FS = new Set(["overlay", "proc", "sysfs", "tmpfs", "devtmpfs", "devpts", "mqueue", "cgroup", "cgroup2", "shm"]);

/** mountinfo escapes space, tab, newline and backslash as `\ooo`. */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** Parse `/proc/<pid>/mountinfo` (see proc(5)). Malformed lines are skipped. */
export function parseMountinfo(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split(" ");
    const sep = fields.indexOf("-", 6);
    if (fields.length < 6 || sep < 0) continue;
    const mountOpts = fields[5].split(",");
    const superOpts = (fields[sep + 3] ?? "").split(",");
    out.push({
      mountPoint: unescapeMountField(fields[4]),
      fsType: fields[sep + 1] ?? "",
      readOnly: mountOpts.includes("ro") || superOpts.includes("ro"),
    });
  }
  return out;
}

function contains(mountPoint: string, path: string): boolean {
  if (mountPoint === "/") return true;
  return path === mountPoint || path.startsWith(mountPoint + "/");
}

/** The most specific mount holding `path`; the last one wins on a tie (it was mounted on top). */
export function mountFor(path: string, mounts: MountEntry[]): MountEntry | null {
  let best: MountEntry | null = null;
  for (const m of mounts) {
    if (!contains(m.mountPoint, path)) continue;
    if (!best || m.mountPoint.length >= best.mountPoint.length) best = m;
  }
  return best;
}

function detectContainer(): boolean {
  return existsSync("/.dockerenv");
}

function readMountinfo(): string {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return "";
  }
}

function notMountedReason(path: string): string {
  return (
    `Kernl corre en Docker y no ve ${path}: agregá esa carpeta (o una que la contenga) a KERNL_PROJECTS_ROOT ` +
    `en el .env y recreá el kernel con docker-compose.host.yml.`
  );
}

function readOnlyReason(path: string, mountPoint: string): string {
  return (
    `Kernl corre en Docker y ve ${path} solo en lectura (está dentro de ${mountPoint}, montada read-only): ` +
    `para que pueda escribir ahí, agregá esa carpeta (o una que la contenga) a KERNL_PROJECTS_ROOT en el .env, ` +
    `que se monta en lectura y escritura, y recreá el kernel con docker-compose.host.yml.`
  );
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The path itself or its closest ancestor that exists; null when not even the root does. */
function nearestExisting(path: string): string | null {
  let cur = path;
  for (;;) {
    if (existsSync(cur)) return cur;
    const parent = nodePath.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Whether the kernel can use `path` as a host folder.
 *
 * - `ok: false` carries a sentence the operator can act on.
 * - `ok: true` says whether the folder is already there (`exists`) and whether
 *   the kernel may write into it (`writable`).
 */
export function hostPathReachable(path: string, opts: HostPathOptions = {}): HostPathCheck {
  const raw = (path ?? "").trim();
  if (!raw || !nodePath.isAbsolute(raw)) {
    return { ok: false, reason: `${raw || "(vacío)"} no es una ruta absoluta: usá una como /home/vos/proyecto o C:\\Users\\vos\\proyecto.` };
  }
  const inContainer = opts.inContainer ?? detectContainer();

  if (inContainer) {
    const abs = nodePath.posix.normalize(raw).replace(/(.)\/+$/, "$1");
    const mount = mountFor(abs, parseMountinfo(opts.mountinfo ?? readMountinfo()));
    if (!mount || mount.mountPoint === "/" || NON_HOST_FS.has(mount.fsType)) {
      return { ok: false, reason: notMountedReason(abs) };
    }
    if (mount.readOnly && opts.requireWritable) {
      return { ok: false, reason: readOnlyReason(abs, mount.mountPoint) };
    }
    return { ok: true, exists: existsSync(abs), writable: !mount.readOnly };
  }

  const anchor = nearestExisting(raw);
  if (!anchor) return { ok: false, reason: `${raw} no existe en esta máquina.` };
  const writable = canWrite(anchor);
  if (!writable && opts.requireWritable) {
    return { ok: false, reason: `Kernl no puede escribir en ${raw} (sin permiso de escritura en ${anchor}).` };
  }
  return { ok: true, exists: anchor === raw || existsSync(raw), writable };
}

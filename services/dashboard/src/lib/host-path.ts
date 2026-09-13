/**
 * Filesystem paths as the kernel reports them, on any host.
 *
 * A native Windows kernel hands back `C:\Users\me\…` or `\\server\share\…`;
 * every other host, and every remote provider (SFTP, S3, WebDAV), speaks
 * POSIX. Code that split on "/" or required a leading "/" turned a Windows
 * path into a single crumb, a parent of "/" and a "must start with /"
 * rejection. These helpers read the flavour from the path itself, so the same
 * UI serves both without asking the server which OS it runs on.
 */

const DRIVE_RE = /^[a-zA-Z]:([\\/]|$)/;
const UNC_RE = /^\\\\([^\\/]+)[\\/]([^\\/]+)[\\/]?/;

/** POSIX `/…`, a drive path `C:\…` / `C:/…`, or a UNC share `\\server\share…`. */
export function isAbsoluteHostPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p) return false;
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function isWindowsStyle(p: string): boolean {
  return DRIVE_RE.test(p) || p.startsWith('\\\\');
}

/** The separator a path already uses: `\` for drive/UNC paths (unless written with `/`), `/` otherwise. */
export function hostPathSep(p: string): '/' | '\\' {
  if (!isWindowsStyle(p)) return '/';
  return p.includes('/') && !p.slice(2).includes('\\') ? '/' : '\\';
}

/** Split into the root (`/`, `C:\`, `\\server\share\`, or "" when relative) and the segments below it. */
export function splitHostPath(p: string): { root: string; parts: string[] } {
  if (!p) return { root: '', parts: [] };
  const unc = UNC_RE.exec(p);
  if (unc) {
    return {
      root: `\\\\${unc[1]}\\${unc[2]}\\`,
      parts: p.slice(unc[0].length).split(/[\\/]/).filter(Boolean),
    };
  }
  if (DRIVE_RE.test(p)) {
    const sep = hostPathSep(p);
    return {
      root: `${p.slice(0, 2).toUpperCase()}${sep}`,
      parts: p.slice(2).split(/[\\/]/).filter(Boolean),
    };
  }
  return { root: p.startsWith('/') ? '/' : '', parts: p.split('/').filter(Boolean) };
}

/** `base` + `name` with the separator `base` already uses. */
export function joinHostPath(base: string, name: string): string {
  if (!base) return name;
  if (base.endsWith('/') || base.endsWith('\\')) return base + name;
  return base + hostPathSep(base) + name;
}

/** The parent directory; a root is its own parent. */
export function parentHostPath(p: string): string {
  const { root, parts } = splitHostPath(p);
  if (parts.length === 0) return root || p;
  return root + parts.slice(0, -1).join(hostPathSep(p));
}

/** The last segment, or the root itself (`/`, `C:\`) when there is none. */
export function basenameHostPath(p: string): string {
  const { root, parts } = splitHostPath(p);
  return parts.length ? parts[parts.length - 1] : root || p;
}

/** Breadcrumbs from the root down: each label with the full path it opens. */
export function hostPathCrumbs(p: string): Array<{ label: string; path: string }> {
  const { root, parts } = splitHostPath(p);
  const sep = hostPathSep(p);
  const out: Array<{ label: string; path: string }> = [];
  if (root) out.push({ label: root.length > 1 ? root.replace(/[\\/]$/, '') : root, path: root });
  let cur = root;
  parts.forEach((part, i) => {
    cur = i === 0 ? root + part : cur + sep + part;
    out.push({ label: part, path: cur });
  });
  return out;
}

function normalizeForCompare(p: string): { key: string; windows: boolean } {
  if (isWindowsStyle(p)) {
    const { root, parts } = splitHostPath(p);
    return { key: (root.replace(/\//g, '\\') + parts.join('\\')).toLowerCase(), windows: true };
  }
  const trimmed = p.endsWith('/') && p !== '/' ? p.slice(0, -1) : p;
  return { key: trimmed, windows: false };
}

/**
 * True when `path` is `root` or lies below it. Windows paths compare
 * case-insensitively and either separator matches; a POSIX root never
 * contains a Windows path or the other way round.
 */
export function isUnderHostPath(path: string, root: string): boolean {
  const p = normalizeForCompare(path);
  const r = normalizeForCompare(root);
  if (p.windows !== r.windows) return false;
  if (p.key === r.key) return true;
  const sep = p.windows ? '\\' : '/';
  const prefix = r.key.endsWith(sep) ? r.key : r.key + sep;
  return p.key.startsWith(prefix);
}

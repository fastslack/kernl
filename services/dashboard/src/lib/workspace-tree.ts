/**
 * The agent workspace browser: turning the flat file list the API returns into
 * the collapsible tree the panel renders.
 *
 * Extracted verbatim from AgentWorld3D.svelte. `buildWsRows` is the reason:
 * it derives directories from file parents, counts files recursively with a
 * cache, and flattens everything into depth-aware rows so no recursive Svelte
 * component is needed — about fifty lines of logic that had no test at all.
 *
 * The collapsed-set state and its toggle stay in the component; this module is
 * pure, so `collapsed` comes in as an argument.
 */

/** Row in the flattened tree — one per directory or file, in render order. */
export type WsTreeRow = {
  path: string;
  name: string;
  depth: number;
  isDir: boolean;
  size: number;
  fileCount: number;
};

// Filter out lockfiles / bun cache dirs / OS junk from the workspace tree.
const WS_HIDDEN_BASENAMES = new Set([
  'bun.lockb', 'bun.lock',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.DS_Store', 'Thumbs.db',
]);

export function isWorkspacePathHidden(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  if (WS_HIDDEN_BASENAMES.has(base)) return true;
  if (/\.(bun[a-z0-9-]*|lockb?|tsbuildinfo)$/i.test(base)) return true;
  if (path.split('/').some(seg => seg === '.bun' || seg.startsWith('.bun-'))) return true;
  return false;
}

/**
 * Build the flattened tree. Directories come from explicit 'dir' entries AND
 * from the parents of every file path, so a workspace that only lists files
 * still renders its folders. Children of a collapsed directory are skipped.
 */
export function buildWsRows(
  files: Array<{ path: string; type: string; size: number }>,
  collapsed: Set<string>,
): WsTreeRow[] {
  const dirs = new Set<string>();
  const leafFiles: Array<{ path: string; size: number }> = [];
  for (const f of files) {
    if (f.type === 'dir') { dirs.add(f.path); continue; }
    leafFiles.push({ path: f.path, size: f.size });
    const segs = f.path.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  const children = new Map<string, { dirs: string[]; files: Array<{ path: string; size: number }> }>();
  const bucket = (k: string) => {
    let c = children.get(k);
    if (!c) { c = { dirs: [], files: [] }; children.set(k, c); }
    return c;
  };
  for (const d of dirs) {
    const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    bucket(parent).dirs.push(d);
    // also register implied ancestors of explicit dir entries
    const segs = d.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  for (const f of leafFiles) {
    const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    bucket(parent).files.push(f);
  }
  const countCache = new Map<string, number>();
  const countFiles = (dir: string): number => {
    const hit = countCache.get(dir);
    if (hit !== undefined) return hit;
    const c = children.get(dir);
    let n = c ? c.files.length : 0;
    if (c) for (const d of c.dirs) n += countFiles(d);
    countCache.set(dir, n);
    return n;
  };
  const rows: WsTreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const c = children.get(dir);
    if (!c) return;
    for (const d of [...new Set(c.dirs)].sort()) {
      rows.push({ path: d, name: d.split('/').pop() ?? d, depth, isDir: true, size: 0, fileCount: countFiles(d) });
      if (!collapsed.has(d)) walk(d, depth + 1);
    }
    for (const f of [...c.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ path: f.path, name: f.path.split('/').pop() ?? f.path, depth, isDir: false, size: f.size, fileCount: 0 });
    }
  };
  walk('', 0);
  return rows;
}

const WS_ICONS: Record<string, string> = {
  ts: '🔷', tsx: '🔷', js: '🟨', jsx: '🟨', mjs: '🟨', cjs: '🟨',
  json: '📋', css: '🎨', scss: '🎨', svelte: '🧩', vue: '🧩',
  html: '🌐', md: '📝', txt: '📄', log: '📄', pdf: '📕',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', ico: '🖼️',
  sh: '⚙️', bash: '⚙️', zsh: '⚙️', py: '🐍', rs: '🦀', go: '🐹',
  sql: '🗄️', db: '🗄️', sqlite: '🗄️',
  yml: '🔧', yaml: '🔧', toml: '🔧', ini: '🔧', conf: '🔧', env: '🔧',
  zip: '📦', tar: '📦', gz: '📦', lock: '🔒',
};

export function wsFileIcon(name: string): string {
  if (name.startsWith('.')) return '🔧';
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  return WS_ICONS[ext] ?? '📄';
}

export function wsFmtSize(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

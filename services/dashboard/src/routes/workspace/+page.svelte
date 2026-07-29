<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { renderMarkdown } from '$lib/workspace-md.js';
  import { highlightCode, detectLang } from '$lib/workspace-highlight.js';
  import { timeAgo } from '$lib/utils.js';

  type WorkspaceRow = { id: string; name: string; description: string; shared: boolean; files: number; bytes: number; mtime: number };
  type Office = { flow_id: string; name: string; color: string; workspaces: WorkspaceRow[] };
  type Entry = { path: string; type: 'file' | 'dir'; size: number };

  let offices: Office[] = [];
  let selectedWs: string | null = null;
  let entries: Entry[] = [];
  let selectedPath: string | null = null;
  let content: string = '';
  let loadingList = false;
  let loadingTree = false;
  let loadingFile = false;
  let error = '';
  let query = '';
  let modalOpen = false;

  /** Read ?ws=<id> from URL so workspaces are deep-linkable. */
  function wsFromUrl(): string | null {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('ws');
  }

  /** Persist the current workspace to ?ws=<id> without reloading the page. */
  function syncUrl(wsId: string): void {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    if (u.searchParams.get('ws') === wsId) return;
    u.searchParams.set('ws', wsId);
    window.history.replaceState({}, '', u.toString());
  }

  async function loadWorkspaces() {
    loadingList = true;
    try {
      const r = await fetch('/api/agents/workspaces');
      const j = await r.json();
      offices = j.offices ?? [];
      if (!selectedWs) {
        // 1. Honour deep-link first: `?ws=<id>` jumps straight to that workspace.
        const requested = wsFromUrl();
        const known = offices.flatMap((o) => o.workspaces).map((w) => w.id);
        if (requested && known.includes(requested)) {
          selectWorkspace(requested);
        } else {
          // 2. Otherwise, fall back to the first workspace of the first office.
          for (const o of offices) {
            if (o.workspaces.length > 0) {
              selectWorkspace(o.workspaces[0].id);
              break;
            }
          }
        }
      }
    } catch (e) {
      error = String(e);
    } finally {
      loadingList = false;
    }
  }

  async function selectWorkspace(wsId: string) {
    selectedWs = wsId;
    syncUrl(wsId);
    loadingTree = true;
    expanded = new Set<string>();  // reset when switching workspace
    try {
      const r = await fetch(`/api/agents/workspace/${encodeURIComponent(wsId)}`);
      const j = await r.json();
      entries = j.files ?? [];
    } catch (e) {
      error = String(e);
    } finally {
      loadingTree = false;
    }
  }

  async function openFile(path: string) {
    if (!selectedWs) return;
    selectedPath = path;
    modalOpen = true;
    loadingFile = true;
    content = '';
    try {
      const r = await fetch(`/api/agents/workspace/${encodeURIComponent(selectedWs)}/file?path=${encodeURIComponent(path)}`);
      const j = await r.json();
      content = j.content ?? '';
    } catch (e) {
      error = String(e);
    } finally {
      loadingFile = false;
    }
  }

  function closeModal() {
    modalOpen = false;
    selectedPath = null;
    content = '';
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && modalOpen) closeModal();
  }

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(content);
    } catch (e) {
      error = 'Clipboard unavailable: ' + String(e);
    }
  }

  function fmtBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
  }

  function fileIcon(name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith('.md')) return '📝';
    if (lower.endsWith('.json') || lower.endsWith('.toml') || lower.endsWith('.yaml') || lower.endsWith('.yml')) return '⚙️';
    if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.jsx')) return '📘';
    if (lower.endsWith('.svelte') || lower.endsWith('.astro') || lower.endsWith('.vue')) return '🧩';
    if (lower.endsWith('.css') || lower.endsWith('.scss')) return '🎨';
    if (lower.endsWith('.html')) return '🌐';
    if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp') || lower.endsWith('.gif') || lower.endsWith('.svg')) return '🖼️';
    if (lower.endsWith('.sql') || lower.endsWith('.db')) return '💾';
    if (lower.endsWith('.py')) return '🐍';
    if (lower.endsWith('.rs')) return '🦀';
    if (lower.endsWith('.go')) return '🐹';
    if (lower.endsWith('.sh')) return '🐚';
    return '📄';
  }

  function langFromPath(p: string): string {
    const m = p.match(/\.([a-zA-Z0-9]+)$/);
    if (!m) return '';
    const ext = m[1].toLowerCase();
    const map: Record<string, string> = {
      ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
      json: 'json', md: 'md', toml: 'toml', yaml: 'yaml', yml: 'yaml',
      astro: 'astro', svelte: 'svelte', html: 'html', css: 'css', scss: 'scss',
      sql: 'sql', sh: 'sh', py: 'py', rs: 'rust', go: 'go',
    };
    return map[ext] ?? ext;
  }

  $: selectedOffice = offices.find(o => o.workspaces.some(w => w.id === selectedWs));
  $: selectedWsRow = selectedOffice?.workspaces.find(w => w.id === selectedWs);

  // Lockfiles / build artifacts / OS junk that clutter the workspace tree.
  // Keep this narrow — matching "startsWith('.')" would hide legit files
  // inside dirs like .claude/ or .config/.
  const HIDDEN_BASENAMES = new Set([
    'bun.lockb', 'bun.lock',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.DS_Store', 'Thumbs.db',
  ]);
  function isHidden(path: string): boolean {
    const base = path.split('/').pop() ?? path;
    if (HIDDEN_BASENAMES.has(base)) return true;
    // .bun / .bunx / .bun-build / .lock / .lockb / .tsbuildinfo extensions
    if (/\.(bun[a-z0-9-]*|lockb?|tsbuildinfo)$/i.test(base)) return true;
    // anything under a `.bun/` segment (bun cache/runtime dirs)
    if (path.split('/').some(seg => seg === '.bun' || seg.startsWith('.bun-'))) return true;
    return false;
  }

  // ── Tree construction ─────────────────────────────────
  type TreeNode = {
    name: string;
    path: string;
    type: 'dir' | 'file';
    size: number;
    depth: number;
    children: TreeNode[];
    /** Contador recursivo de files (solo dirs). */
    fileCount?: number;
  };

  let expanded = new Set<string>(); // paths de dirs abiertos

  /**
   * Build a hierarchical tree from the flat entry list. Creates implicit
   * dirs when a file references a parent that never arrived as its own
   * entrada explícita. Ordena: dirs primero, luego files, alfabético.
   */
  function buildTree(flat: Entry[]): TreeNode[] {
    const rootChildren: TreeNode[] = [];
    const byPath = new Map<string, TreeNode>();

    function ensureDir(dirPath: string): TreeNode {
      const hit = byPath.get(dirPath);
      if (hit) return hit;
      const parts = dirPath.split('/');
      const name = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join('/');
      const node: TreeNode = {
        name,
        path: dirPath,
        type: 'dir',
        size: 0,
        depth: parts.length - 1,
        children: [],
        fileCount: 0,
      };
      byPath.set(dirPath, node);
      if (parentPath) ensureDir(parentPath).children.push(node);
      else rootChildren.push(node);
      return node;
    }

    for (const e of flat) {
      if (isHidden(e.path)) continue;
      const parts = e.path.split('/');
      const parentPath = parts.slice(0, -1).join('/');
      if (e.type === 'dir') {
        ensureDir(e.path);
      } else {
        const leaf: TreeNode = {
          name: parts[parts.length - 1],
          path: e.path,
          type: 'file',
          size: e.size,
          depth: parts.length - 1,
          children: [],
        };
        if (parentPath) ensureDir(parentPath).children.push(leaf);
        else rootChildren.push(leaf);
      }
    }

    // Recursive file counts (to show "N items" on each dir)
    function countFiles(nodes: TreeNode[]): number {
      let n = 0;
      for (const node of nodes) {
        if (node.type === 'file') n += 1;
        else { node.fileCount = countFiles(node.children); n += node.fileCount; }
      }
      return n;
    }
    countFiles(rootChildren);

    // Orden: dirs primero, alfabético
    function sortNode(nodes: TreeNode[]) {
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const n of nodes) if (n.type === 'dir') sortNode(n.children);
    }
    sortNode(rootChildren);

    return rootChildren;
  }

  $: tree = buildTree(entries);

  // Paths matching the query (case insensitive, matched anywhere in the path)
  function collectMatches(nodes: TreeNode[], q: string, acc: Set<string> = new Set()): Set<string> {
    for (const n of nodes) {
      if (n.path.toLowerCase().includes(q)) acc.add(n.path);
      if (n.children.length) collectMatches(n.children, q, acc);
    }
    return acc;
  }

  // Ancestros de un path (para auto-expand)
  function ancestors(path: string): string[] {
    const parts = path.split('/');
    const out: string[] = [];
    for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
    return out;
  }

  // When there's a query, auto-expand the ancestors of every match
  $: effectiveExpanded = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return expanded;
    const matches = collectMatches(tree, q);
    const exp = new Set(expanded);
    for (const p of matches) for (const a of ancestors(p)) exp.add(a);
    return exp;
  })();

  /** Flatten the tree down to the visible nodes only (children of expanded dirs). */
  function flattenVisible(nodes: TreeNode[], exp: Set<string>, q: string): TreeNode[] {
    const out: TreeNode[] = [];
    for (const n of nodes) {
      const nameMatch = !q || n.path.toLowerCase().includes(q);
      if (n.type === 'file') {
        if (nameMatch) out.push(n);
        continue;
      }
      // dir
      const childrenFlat = flattenVisible(n.children, exp, q);
      // Show a dir if it matches, OR if any of its descendants match
      if (nameMatch || childrenFlat.length > 0) {
        out.push(n);
        if (exp.has(n.path)) out.push(...childrenFlat);
      }
    }
    return out;
  }

  $: displayList = flattenVisible(tree, effectiveExpanded, query.trim().toLowerCase());

  function toggleDir(path: string) {
    // If the dir was expanded by the query, clone the set before manual editing
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expanded = next;
  }

  function expandAll() {
    const next = new Set<string>();
    function walk(nodes: TreeNode[]) {
      for (const n of nodes) {
        if (n.type === 'dir') { next.add(n.path); walk(n.children); }
      }
    }
    walk(tree);
    expanded = next;
  }

  function collapseAll() {
    expanded = new Set<string>();
  }

  // On workspace change, reset the expanded state (expand only top-level for a first impression)
  $: if (selectedWs) {
    // (don't touch `expanded` directly here to avoid loops; we do it in selectWorkspace)
  }

  function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
    if (!md.startsWith('---\n')) return { meta: {}, body: md };
    const end = md.indexOf('\n---', 4);
    if (end === -1) return { meta: {}, body: md };
    const raw = md.slice(4, end);
    const body = md.slice(end + 4).replace(/^\n/, '');
    const meta: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return { meta, body };
  }

  $: isMd = !!selectedPath && selectedPath.endsWith('.md');
  $: parsed = isMd ? parseFrontmatter(content) : { meta: {}, body: content };
  $: renderedBody = isMd ? renderMarkdown(parsed.body) : '';
  $: modalTitle = selectedPath
    ? (isMd && parsed.meta.title ? parsed.meta.title : selectedPath.split('/').pop() ?? selectedPath)
    : '';

  onMount(() => {
    loadWorkspaces();
    window.addEventListener('keydown', onKeydown);
  });
  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown);
  });
</script>

<div class="workspace-page">
  <aside class="offices">
    <div class="panel-header">
      <h2>Offices / Workspaces</h2>
      <button class="refresh" on:click={loadWorkspaces} title="Refresh">↻</button>
    </div>
    {#if loadingList}
      <div class="muted">Loading…</div>
    {:else if offices.length === 0}
      <div class="muted">No workspaces yet. Offices create them via <code>kernel_workspace_create</code>.</div>
    {:else}
      <div class="office-tree">
        {#each offices as o}
          <div class="office-group">
            <div class="office-header" style:border-left-color={o.color}>
              <span class="office-dot" style:background={o.color}></span>
              <span class="office-name">{o.name}</span>
            </div>
            <ul class="workspace-list">
              {#each o.workspaces as w}
                <li>
                  <button
                    class:active={selectedWs === w.id}
                    on:click={() => selectWorkspace(w.id)}
                    title={w.description}
                  >
                    <div class="ws-row-top">
                      <span class="ws-name">{w.name}</span>
                      {#if w.shared}<span class="shared-badge" title="Shared — other offices can read">shared</span>{/if}
                    </div>
                    <div class="ws-meta">
                      <span>{w.files} files</span>
                      <span>{fmtBytes(w.bytes)}</span>
                      {#if w.mtime}<span>{timeAgo(new Date(w.mtime).toISOString())}</span>{/if}
                    </div>
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>
    {/if}
  </aside>

  <section class="tree">
    <div class="panel-header">
      <h2>
        {#if selectedWsRow}
          {selectedOffice?.name} / <span class="accent">{selectedWsRow.name}</span>
          {#if selectedWsRow.shared}<span class="shared-badge">shared</span>{/if}
        {:else}
          Files
        {/if}
      </h2>
      <input type="text" placeholder="Filter…" bind:value={query} />
    </div>
    {#if !selectedWs}
      <div class="muted">Pick a workspace on the left.</div>
    {:else if loadingTree}
      <div class="muted">Loading…</div>
    {:else if entries.length === 0}
      <div class="muted">This workspace is empty.</div>
    {:else}
      <div class="tree-toolbar">
        <button class="tb-btn" on:click={expandAll} title="Expandir todo">⊞ Expandir</button>
        <button class="tb-btn" on:click={collapseAll} title="Colapsar todo">⊟ Colapsar</button>
        <span class="tb-count">{displayList.length} visibles de {entries.filter(e => !isHidden(e.path)).length}</span>
      </div>
      <ul class="tree-list">
        {#each displayList as n (n.path)}
          <li>
            {#if n.type === 'dir'}
              {@const isOpen = effectiveExpanded.has(n.path)}
              <button
                class="tree-row dir"
                style:padding-left={`${6 + n.depth * 14}px`}
                on:click={() => toggleDir(n.path)}
              >
                <span class="chevron" class:open={isOpen}>▸</span>
                <span class="icon">{isOpen ? '📂' : '📁'}</span>
                <span class="name">{n.name}</span>
                <span class="count">{n.fileCount ?? 0}</span>
              </button>
            {:else}
              <button
                class="tree-row file"
                class:active={selectedPath === n.path && modalOpen}
                style:padding-left={`${6 + n.depth * 14 + 14}px`}
                on:click={() => openFile(n.path)}
              >
                <span class="icon">{fileIcon(n.name)}</span>
                <span class="name">{n.name}</span>
                <span class="size">{fmtBytes(n.size)}</span>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

{#if modalOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={closeModal} role="presentation">
    <div class="modal" on:click|stopPropagation role="dialog" aria-modal="true">
      <header class="modal-head">
        <div class="modal-head-left">
          <h1 class="modal-title">{modalTitle}</h1>
          <div class="modal-meta">
            {#if selectedOffice && selectedWsRow}
              <span class="ws-pill" style:border-left-color={selectedOffice.color}>
                {selectedOffice.name} / {selectedWsRow.name}
              </span>
            {/if}
            <span class="path-pill">{selectedPath}</span>
            {#if isMd && parsed.meta.author}<span><strong>Author:</strong> {parsed.meta.author}</span>{/if}
            {#if isMd && parsed.meta.date}<span><strong>Date:</strong> {new Date(parsed.meta.date).toLocaleString()}</span>{/if}
            {#if isMd && parsed.meta.tags && parsed.meta.tags !== '[]'}<span><strong>Tags:</strong> <code>{parsed.meta.tags}</code></span>{/if}
          </div>
        </div>
        <div class="modal-head-actions">
          <button class="modal-action" on:click={copyContent} title="Copy file contents">Copy</button>
          <button class="modal-close" on:click={closeModal} title="Close (Esc)">✕</button>
        </div>
      </header>
      <div class="modal-body" class:md={isMd}>
        {#if loadingFile}
          <div class="muted">Loading…</div>
        {:else if isMd}
          <div class="md-body">{@html renderedBody}</div>
        {:else}
          <pre class="code"><code data-lang={langFromPath(selectedPath ?? '')}>{@html highlightCode(content, detectLang(selectedPath ?? ''))}</code></pre>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if error}
  <div class="error">{error}<button on:click={() => (error = '')}>✕</button></div>
{/if}

<style>
  .workspace-page {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 12px;
    height: calc(100vh - 120px);
    padding: 12px;
  }
  aside, section {
    background: var(--panel-bg, rgba(18, 22, 38, 0.7));
    border: 1px solid var(--panel-border, rgba(90, 110, 160, 0.25));
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--panel-border, rgba(90, 110, 160, 0.2));
    background: rgba(0, 0, 0, 0.2);
  }
  .panel-header h2 {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted, #8fa0c3);
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .panel-header h2 .accent { color: var(--fg, #e8ecf5); text-transform: none; letter-spacing: 0; font-family: 'Fira Code', monospace; font-size: 11px; }
  .panel-header input {
    width: 160px;
    background: transparent;
    border: 1px solid var(--panel-border, rgba(90, 110, 160, 0.3));
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11px;
    color: inherit;
  }
  .refresh {
    background: transparent; border: none; color: var(--muted, #8fa0c3);
    cursor: pointer; font-size: 14px;
  }
  .refresh:hover { color: var(--fg, #e8ecf5); }

  .offices { overflow-y: auto; }
  .office-tree { padding: 6px 4px; }
  .office-group { margin-bottom: 8px; }
  .office-header {
    display: flex; align-items: center; gap: 7px;
    padding: 7px 10px 5px;
    border-left: 3px solid transparent;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg, #e8ecf5);
  }
  .office-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .workspace-list { list-style: none; margin: 0; padding: 0 0 0 18px; }
  .workspace-list li { margin: 0; }
  .workspace-list button {
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 6px 8px;
    cursor: pointer;
    color: inherit;
    border-radius: 4px;
    transition: background 0.12s;
  }
  .workspace-list button:hover { background: rgba(90, 110, 160, 0.08); }
  .workspace-list button.active { background: rgba(99, 102, 241, 0.14); }
  .ws-row-top { display: flex; align-items: center; gap: 6px; }
  .ws-name { font-size: 12px; font-family: 'Fira Code', monospace; }
  .ws-meta { display: flex; gap: 10px; font-size: 10px; color: var(--muted, #8fa0c3); margin-top: 2px; }
  .shared-badge {
    display: inline-block;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 1px 6px;
    background: rgba(16, 185, 129, 0.18);
    color: #34d399;
    border-radius: 3px;
  }

  .tree { overflow-y: auto; display: flex; flex-direction: column; min-height: 0; }

  .tree-toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.12);
    border-bottom: 1px solid var(--panel-border, rgba(90, 110, 160, 0.15));
    font-size: 10px;
    flex-shrink: 0;
  }
  .tb-btn {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(90, 110, 160, 0.25));
    color: var(--muted, #8fa0c3);
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 10px;
    font-family: inherit;
  }
  .tb-btn:hover { color: var(--fg, #e8ecf5); border-color: rgba(120, 140, 200, 0.5); }
  .tb-count { margin-left: auto; color: var(--muted, #8fa0c3); font-size: 10px; font-family: 'Fira Code', monospace; }

  .tree-list { list-style: none; padding: 4px 0; margin: 0; overflow-y: auto; flex: 1; }
  .tree-list li { margin: 0; }

  .tree-row {
    display: flex; gap: 5px; align-items: center;
    width: 100%; text-align: left;
    background: transparent; border: none;
    padding: 3px 10px;
    color: inherit;
    cursor: pointer;
    font-size: 12px;
    line-height: 1.3;
    transition: background 0.08s;
  }
  .tree-row:hover { background: rgba(90, 110, 160, 0.10); }
  .tree-row.active { background: rgba(99, 102, 241, 0.22); color: var(--fg, #e8ecf5); }
  .tree-row .name {
    flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: 'Fira Code', monospace;
  }
  .tree-row .size { color: var(--muted, #8fa0c3); font-size: 10px; flex-shrink: 0; }
  .tree-row .icon { flex-shrink: 0; font-size: 11px; width: 14px; text-align: center; }

  .tree-row.dir {
    font-weight: 500;
    color: var(--fg, #e8ecf5);
  }
  .tree-row.dir .count {
    color: var(--muted, #8fa0c3);
    font-size: 10px;
    font-family: 'Fira Code', monospace;
    background: rgba(90, 110, 160, 0.10);
    padding: 0 6px;
    border-radius: 8px;
    flex-shrink: 0;
  }

  .chevron {
    display: inline-block;
    width: 10px;
    font-size: 9px;
    color: var(--muted, #8fa0c3);
    transition: transform 0.14s ease;
    flex-shrink: 0;
  }
  .chevron.open { transform: rotate(90deg); }

  /* ── Modal ── */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(3px);
    z-index: 100;
    display: flex; align-items: center; justify-content: center;
    padding: 4vh 4vw;
    animation: fadeIn 0.12s ease;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .modal {
    width: min(1100px, 100%);
    max-height: 100%;
    background: var(--panel-bg, #0f1326);
    border: 1px solid var(--panel-border, rgba(120, 140, 200, 0.3));
    border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
    display: flex; flex-direction: column;
    overflow: hidden;
    animation: popIn 0.18s ease;
  }
  @keyframes popIn { from { transform: translateY(8px) scale(0.985); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }

  .modal-head {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 16px;
    padding: 16px 20px 14px;
    border-bottom: 1px solid var(--panel-border, rgba(90, 110, 160, 0.2));
    background: rgba(0, 0, 0, 0.25);
  }
  .modal-head-left { min-width: 0; flex: 1; }
  .modal-title {
    font-size: 17px; margin: 0 0 6px 0;
    color: var(--fg, #e8ecf5);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .modal-meta {
    display: flex; flex-wrap: wrap; gap: 10px;
    font-size: 11px; color: var(--muted, #8fa0c3);
    align-items: center;
  }
  .modal-meta code {
    background: rgba(90, 110, 160, 0.15);
    padding: 1px 5px; border-radius: 3px;
    font-family: 'Fira Code', monospace;
  }
  .modal-meta .path-pill {
    font-family: 'Fira Code', monospace;
    background: rgba(99, 102, 241, 0.12);
    padding: 3px 8px; border-radius: 4px;
    color: #a3b3ff;
  }
  .modal-meta .ws-pill {
    font-family: 'Fira Code', monospace;
    background: rgba(90, 110, 160, 0.12);
    padding: 3px 8px; border-radius: 4px;
    border-left: 3px solid transparent;
    color: var(--fg, #e8ecf5);
  }
  .modal-head-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .modal-action, .modal-close {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(120, 140, 200, 0.3));
    color: var(--muted, #8fa0c3);
    padding: 6px 12px; border-radius: 5px;
    cursor: pointer; font-size: 11px; font-weight: 500;
    transition: all 0.12s;
  }
  .modal-action:hover { color: var(--fg, #e8ecf5); border-color: rgba(120, 140, 200, 0.5); }
  .modal-close { padding: 6px 10px; font-size: 14px; }
  .modal-close:hover { color: #ff8080; border-color: rgba(255, 128, 128, 0.5); }

  .modal-body { overflow: auto; min-height: 0; flex: 1; }
  .modal-body.md { padding: 0; }
  .modal-body .md-body { padding: 22px 28px 40px; line-height: 1.65; font-size: 13px; color: var(--fg, #e8ecf5); }
  .modal-body .code {
    margin: 0; padding: 18px 22px;
    font-family: 'Fira Code', 'JetBrains Mono', monospace;
    font-size: 12.5px; line-height: 1.55;
    white-space: pre; tab-size: 2;
    overflow: auto;
    color: #d5daea;
    background: rgba(0, 0, 0, 0.22);
  }
  .modal-body .code code { background: transparent; padding: 0; font-size: inherit; display: block; min-width: max-content; }
  /* Syntax highlighting palette (shared with agents-flow preview) */
  :global(.modal-body .code .hl-kw)  { color:#c586c0; }
  :global(.modal-body .code .hl-str) { color:#ce9178; }
  :global(.modal-body .code .hl-num) { color:#b5cea8; }
  :global(.modal-body .code .hl-com) { color:#6a9955; font-style:italic; }
  :global(.modal-body .code .hl-fn)  { color:#dcdcaa; }
  :global(.modal-body .code .hl-typ) { color:#4ec9b0; }
  :global(.modal-body .code .hl-key) { color:#9cdcfe; }
  :global(.modal-body .code .hl-pun) { color:#9a9fb2; }

  :global(.modal-body .md-body h1),
  :global(.modal-body .md-body h2),
  :global(.modal-body .md-body h3),
  :global(.modal-body .md-body h4),
  :global(.modal-body .md-body h5),
  :global(.modal-body .md-body h6) {
    margin-top: 1.4em; margin-bottom: 0.5em; line-height: 1.3;
  }
  :global(.modal-body .md-body h1) { font-size: 22px; }
  :global(.modal-body .md-body h2) { font-size: 17px; border-bottom: 1px solid rgba(90, 110, 160, 0.15); padding-bottom: 4px; }
  :global(.modal-body .md-body h3) { font-size: 14px; }
  :global(.modal-body .md-body p) { margin: 10px 0; }
  :global(.modal-body .md-body ul), :global(.modal-body .md-body ol) { padding-left: 22px; margin: 8px 0; }
  :global(.modal-body .md-body li) { margin: 3px 0; }
  :global(.modal-body .md-body code) { background: rgba(90, 110, 160, 0.12); padding: 1px 5px; border-radius: 3px; font-size: 90%; font-family: 'Fira Code', monospace; }
  :global(.modal-body .md-body pre.md-code) {
    background: rgba(0, 0, 0, 0.32);
    border: 1px solid rgba(90, 110, 160, 0.2);
    padding: 12px 14px; border-radius: 6px;
    overflow-x: auto; margin: 12px 0;
    font-size: 12px; line-height: 1.55;
  }
  :global(.modal-body .md-body pre.md-code code) { background: transparent; padding: 0; font-size: inherit; white-space: pre; }
  :global(.modal-body .md-body blockquote) {
    border-left: 3px solid rgba(99, 102, 241, 0.5);
    margin: 12px 0; padding: 2px 14px;
    color: var(--muted, #a8b5d1);
    background: rgba(99, 102, 241, 0.05);
  }
  :global(.modal-body .md-body a) { color: #7c92ff; text-decoration: underline; }
  :global(.modal-body .md-body a:hover) { color: #a3b3ff; }
  :global(.modal-body .md-body del) { opacity: 0.6; }
  :global(.modal-body .md-body table.md-table) {
    border-collapse: collapse; margin: 12px 0; font-size: 12px; width: auto;
  }
  :global(.modal-body .md-body table.md-table th),
  :global(.modal-body .md-body table.md-table td) {
    border: 1px solid rgba(90, 110, 160, 0.2);
    padding: 6px 10px; text-align: left;
  }
  :global(.modal-body .md-body table.md-table th) { background: rgba(90, 110, 160, 0.1); font-weight: 600; }
  :global(.modal-body .md-body hr) { border: none; border-top: 1px solid rgba(90, 110, 160, 0.2); margin: 18px 0; }

  .muted { padding: 16px; color: var(--muted, #8fa0c3); font-size: 12px; }

  .error {
    position: fixed;
    bottom: 20px; right: 20px;
    background: #ef4444; color: white;
    padding: 10px 14px; border-radius: 6px;
    display: flex; gap: 10px; align-items: center;
    font-size: 12px; z-index: 200;
  }
  .error button { background: transparent; border: none; color: white; cursor: pointer; }
</style>

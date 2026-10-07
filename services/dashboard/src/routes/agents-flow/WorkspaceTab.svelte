<script lang="ts">
  /**
   * WORKSPACE tab of the agent drawer — the cwd card plus a collapsible file
   * tree, and the single-file viewer it opens into.
   *
   * The fetches stay in AgentWorld3D: they need `selectedAgent`, the agent
   * list and `resolveAgentWorkspace`, and the world resets this panel's state
   * whenever it reloads. So the data arrives as props, the two pieces the
   * parent also writes (`collapsed`, `fileContent`) are two-way bound, and
   * opening a file is a callback.
   *
   * Row building moved here with the markup — `wsRows`, `wsAllDirs` and
   * `wsFileCount` had no other reader.
   */
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import { safeParse } from '$lib/agent-helpers.js';
  import { buildWsRows, wsFileIcon, wsFmtSize } from '$lib/workspace-tree.js';
  import { highlightCode, detectLang } from '$lib/workspace-highlight.js';
  import { renderMarkdown } from '$lib/workspace-md.js';

  /** Resolved workspace of the selected agent, or null when it has none. */
  export let info: {
    cwdLabel: string;
    cwdHint: string;
    wsId?: string | null;
    cwdPath?: string | null;
  } | null = null;

  /** The agent's raw `variables` blob — read for extra dirs and the sandbox. */
  export let variables: any = null;

  /** Live preview URL for a __cwd_path__ repo, when the API returns one. */
  export let previewUrl: string | null = null;

  export let loading = false;

  /** Already filtered by the parent (hidden paths removed). */
  export let files: Array<{ path: string; type: string; size: number }> = [];

  /** Bound: the parent clears it on every workspace reload. */
  export let collapsed: Set<string> = new Set();

  /** Bound: the parent fills it on open and clears it on reload. */
  export let fileContent: { path: string; content: string; source?: 'agent' | 'repo' } | null = null;

  /**
   * The agent's own files (memory, notes, drafts) when it works on a repo —
   * kept in a second section so they never read as part of the developer's
   * code. Null when the agent has no repo: then `files` already are its own.
   */
  export let notes: { wsId: string; label: string; files: Array<{ path: string; type: string; size: number }>; loading: boolean } | null = null;

  /**
   * The tree arrives one folder at a time: the parent fetches a folder when it
   * is opened (a real repo is hundreds of thousands of files). "Expand all"
   * would fetch every folder, so it is not offered, and the total file count
   * is unknown.
   */
  export let lazy = false;
  /** Folders the server cut short: entries not listed, per folder ('' = root). */
  export let more: Map<string, number> = new Map();
  /** Folders being fetched right now. */
  export let loadingDirs: Set<string> = new Set();

  /** Ask the world to fetch one file — it knows which endpoint applies. */
  export let onOpenFile: (path: string, source: 'agent' | 'repo') => void = () => {};

  // Two sections: the agent's own files, and the repo it works on.
  $: hasRepo = !!info?.cwdPath;
  $: agentFiles = hasRepo ? (notes?.files ?? []) : files;
  $: repoFiles = hasRepo ? files : [];
  let section: 'agent' | 'repo' = 'agent';
  // Open on the repo the agent works on; switching agent starts over.
  let sectionFor = '';
  $: if (info && sectionFor !== info.cwdLabel) {
    sectionFor = info.cwdLabel;
    section = hasRepo ? 'repo' : 'agent';
    agentCollapsed = new Set();
  }
  $: if (!hasRepo) section = 'agent';
  let agentCollapsed: Set<string> = new Set();

  $: onRepo = section === 'repo';
  $: shownFiles = onRepo ? repoFiles : agentFiles;
  $: shownCollapsed = onRepo ? collapsed : agentCollapsed;
  $: shownLazy = onRepo && lazy;

  function toggleWsDir(path: string): void {
    const set = onRepo ? collapsed : agentCollapsed;
    if (set.has(path)) set.delete(path); else set.add(path);
    if (onRepo) collapsed = collapsed; else agentCollapsed = agentCollapsed;
  }
  function setCollapsed(next: Set<string>): void {
    if (onRepo) collapsed = next; else agentCollapsed = next;
  }

  $: wsRows = buildWsRows(shownFiles, shownCollapsed, onRepo ? more : new Map());
  $: wsAllDirs = [...new Set(buildWsRows(shownFiles, new Set()).filter(r => r.isDir).map(r => r.path))];
  $: wsFileCount = shownFiles.filter(f => f.type !== 'dir').length;
  $: agentFileCount = agentFiles.filter(f => f.type !== 'dir').length;
  $: repoName = (info?.cwdPath ?? '').split('/').filter(Boolean).pop() ?? '';
</script>

<div class="ws-panel">
  {#if info}
    {@const vars = safeParse(variables) || {}}
    {@const extraDirs = Array.isArray(vars.__additional_directories__)
      ? vars.__additional_directories__
      : (typeof vars.__additional_directories__ === 'string'
          ? (safeParse(vars.__additional_directories__) || [])
          : [])}
    {@const sandboxDriver = vars.__sandbox_driver__ || (vars.__container_sandbox__ ? 'docker' : '')}

    <!-- Two worlds, never mixed: what the agent keeps for itself, and the
         developer's repo it works on. Each has its own colour throughout. -->
    {#if hasRepo}
      <div class="ws-sections" role="tablist" aria-label="Archivos">
        <button role="tab" class="ws-sec ws-sec-agent" class:on={!onRepo} aria-selected={!onRepo} on:click={() => { section = 'agent'; fileContent = null; }}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6c0 2.2 1.2 3.6 2 4.5V17h8v-3.5c.8-.9 2-2.3 2-4.5a6 6 0 0 0-6-6Z"/><path d="M9.5 21h5"/></svg>
          <span class="ws-sec-txt"><b>Del agente</b><small>memoria, notas y apuntes</small></span>
          <span class="ws-sec-n">{notes?.loading ? '…' : agentFileCount}</span>
        </button>
        <button role="tab" class="ws-sec ws-sec-repo" class:on={onRepo} aria-selected={onRepo} on:click={() => { section = 'repo'; fileContent = null; }}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8"/><path d="M18 10c0 4-6 3-10 6"/></svg>
          <span class="ws-sec-txt"><b>Repositorio</b><small>{repoName || 'código del proyecto'}</small></span>
        </button>
      </div>
    {/if}

    {#if onRepo}
      <div class="ws-cwd-card ws-card-repo">
        <div class="ws-card-title">Repositorio del desarrollador <span>el código del proyecto · lo que el agente edita acá queda en el repo</span></div>
        <div class="ws-cwd-row">
          <span class="ws-cwd-lbl">cwd</span>
          <code class="ws-cwd-path">{info.cwdLabel}</code>
        </div>
        <div class="ws-cwd-hint">{info.cwdHint}</div>
        {#if previewUrl}
          <div class="ws-cwd-row ws-cwd-preview">
            <span class="ws-cwd-lbl">preview</span>
            <a class="ws-preview-link" style="color:#4ade80;word-break:break-all;text-decoration:none" href={previewUrl} target="_blank" rel="noopener noreferrer">🔗 {previewUrl}</a>
          </div>
        {/if}
        {#if extraDirs.length}
          <div class="ws-cwd-row ws-cwd-extra">
            <span class="ws-cwd-lbl">+dirs</span>
            <div class="ws-cwd-paths">
              {#each extraDirs as d}<code class="ws-cwd-path">{d}</code>{/each}
            </div>
          </div>
        {/if}
        <div class="ws-cwd-row ws-cwd-guard" class:warn={!sandboxDriver}>
          <span class="ws-cwd-lbl">guard</span>
          {#if sandboxDriver}
            <span class="ws-guard-ok">📦 sandbox: {sandboxDriver} — Bash confinado al sandbox</span>
          {:else}
            <span class="ws-guard-warn">⚠ no sandbox — Read/Edit/Write/Glob/Grep are scoped to the cwd, but <strong>Bash is unrestricted inside the kernel container</strong></span>
          {/if}
        </div>
      </div>
    {:else}
      <div class="ws-cwd-card ws-card-agent">
        <div class="ws-card-title">Archivos del agente <span>su memoria, notas y apuntes · {hasRepo ? 'no son parte del repositorio' : 'este agente no trabaja sobre un repositorio'}</span></div>
        <div class="ws-cwd-row">
          <span class="ws-cwd-lbl">dónde</span>
          <code class="ws-cwd-path">{hasRepo ? notes?.label : info.cwdLabel}</code>
        </div>
        {#if !hasRepo}<div class="ws-cwd-hint">{info.cwdHint}</div>{/if}
      </div>
    {/if}
  {/if}
  {#if loading || (!onRepo && notes?.loading)}
    <div class="ws-loading">Cargando archivos…</div>
  {:else if !info?.wsId && !info?.cwdPath}
    <div class="ws-empty">This agent uses <code>__cwd_path__</code> (an absolute path). To see it, register it as a workspace or browse via the global Workspace tab.</div>
  {:else if fileContent}
    <div class="ws-file-view">
      <div class="ws-file-header">
        <button class="ws-back" on:click={() => fileContent = null}>← Back</button>
        {#if hasRepo}
          <span class="ws-origin" class:repo={fileContent.source !== 'agent'}>{fileContent.source === 'agent' ? 'agente' : 'repo'}</span>
        {/if}
        <span class="ws-file-path">{fileContent.path}</span>
        {#if detectLang(fileContent.path)}
          <span class="ws-file-lang">{detectLang(fileContent.path)}</span>
        {/if}
      </div>
      <div class="copy-wrap">
        <CopyTextBtn text={fileContent.content} title="Copy file contents" />
        {#if fileContent.path.endsWith('.md')}
          <div class="ws-file-md md-body">{@html renderMarkdown(fileContent.content)}</div>
        {:else}
          <pre class="ws-file-code"><code>{@html highlightCode(fileContent.content, detectLang(fileContent.path))}</code></pre>
        {/if}
      </div>
    </div>
  {:else if shownFiles.length === 0}
    <div class="ws-empty">{onRepo ? 'El repositorio no tiene archivos para mostrar.' : 'El agente todavía no guardó archivos propios.'}</div>
  {:else}
    <div class="ws-toolbar">
      {#if !shownLazy}<span class="ws-count">{wsFileCount} {wsFileCount === 1 ? 'file' : 'files'}</span>{/if}
      <button class="ws-tb-btn" on:click={() => setCollapsed(new Set(wsAllDirs))} disabled={shownCollapsed.size >= wsAllDirs.length}>⊟ Collapse all</button>
      {#if !shownLazy}<button class="ws-tb-btn" on:click={() => setCollapsed(new Set())} disabled={shownCollapsed.size === 0}>⊞ Expand all</button>{/if}
    </div>
    <div class="ws-tree" class:ws-tree-agent={!onRepo} class:ws-tree-repo={onRepo && hasRepo}>
      {#each wsRows as r (r.path)}
        {#if r.isDir}
          <button class="ws-row ws-dir" on:click={() => toggleWsDir(r.path)} title={r.path}>
            {#each { length: r.depth } as _}<span class="ws-guide"></span>{/each}
            <span class="ws-chev" class:open={!shownCollapsed.has(r.path)}>▸</span>
            <span class="ws-icon">{shownCollapsed.has(r.path) ? '📁' : '📂'}</span>
            <span class="ws-name ws-dirname">{r.name}</span>
            <span class="ws-badge">{onRepo && loadingDirs.has(r.path) ? '…' : r.fileCount}</span>
          </button>
        {:else if r.more}
          <div class="ws-row ws-more" title="Folder too big to list whole">
            {#each { length: r.depth } as _}<span class="ws-guide"></span>{/each}
            <span class="ws-chev-spacer"></span>
            <span class="ws-name">{r.name}</span>
          </div>
        {:else}
          <button class="ws-row ws-file" on:click={() => onOpenFile(r.path, onRepo ? 'repo' : 'agent')} title={r.path}>
            {#each { length: r.depth } as _}<span class="ws-guide"></span>{/each}
            <span class="ws-chev-spacer"></span>
            <span class="ws-icon">{wsFileIcon(r.name)}</span>
            <span class="ws-name">{r.name}</span>
            <span class="ws-size">{wsFmtSize(r.size)}</span>
          </button>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Moved wholesale from AgentWorld3D — no other markup used these.
     `.copy-wrap` is not here: it is declared `:global` in the parent and
     reaches this component on its own. */

  /* ── Workspace panel ──────────── */
  .ws-panel{padding:8px 0;overflow-y:auto;max-height:calc(100% - 120px);scrollbar-width:thin}
  .ws-loading,.ws-empty{padding:24px 16px;text-align:center;color:#6a6f82;font:500 12px 'Manrope',sans-serif}
  .ws-empty code{padding:1px 6px;border-radius:3px;background:rgba(120,130,160,.12);color:#c0c5d8;font:500 10px 'JetBrains Mono',monospace}
  /* cwd card — header of the workspace tab showing the agent's working
     directory and the guardrails applied on top of it */
  .ws-cwd-card{
    margin:0 8px 10px;padding:10px 12px;border-radius:8px;
    background:linear-gradient(180deg,rgba(99,102,241,.08),rgba(99,102,241,.03));
    border:1px solid rgba(99,102,241,.18);
    display:flex;flex-direction:column;gap:6px;
  }
  .ws-cwd-row{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
  .ws-cwd-lbl{
    flex-shrink:0;padding:2px 8px;border-radius:3px;
    background:rgba(99,102,241,.18);color:#a5a8e8;
    font:600 9px/14px 'JetBrains Mono',monospace;letter-spacing:.5px;text-transform:uppercase;
  }
  .ws-cwd-path{
    flex:1;min-width:0;padding:2px 6px;border-radius:3px;
    background:rgba(0,0,0,.25);color:#e2e4f0;
    font:500 11px/16px 'JetBrains Mono',monospace;
    word-break:break-all;
  }
  .ws-cwd-paths{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
  .ws-cwd-hint{font:500 10px 'Manrope',sans-serif;color:#7a7f96;padding-left:2px}
  .ws-cwd-extra .ws-cwd-lbl{background:rgba(180,140,80,.18);color:#d8b878}
  .ws-cwd-guard{margin-top:2px;padding-top:6px;border-top:1px dashed rgba(120,130,160,.2)}
  .ws-cwd-guard .ws-cwd-lbl{background:rgba(80,180,120,.18);color:#7ed8a4}
  .ws-cwd-guard.warn .ws-cwd-lbl{background:rgba(220,140,60,.20);color:#e8b070}
  .ws-guard-ok{flex:1;font:500 11px 'Manrope',sans-serif;color:#7ed8a4}
  .ws-guard-warn{flex:1;font:500 11px 'Manrope',sans-serif;color:#e8b070;line-height:1.45}
  .ws-guard-warn strong{color:#f0d8a0}
  /* Workspace file tree — collapsible dirs with indent guides */
  .ws-toolbar{
    display:flex;align-items:center;gap:6px;margin:0 8px 6px;padding:0 4px;
  }
  .ws-count{
    flex:1;font:600 10px 'JetBrains Mono',monospace;color:#6a6f82;
    letter-spacing:.04em;text-transform:uppercase;
  }
  .ws-tb-btn{
    padding:3px 9px;border-radius:5px;border:1px solid rgba(120,130,160,.18);
    background:rgba(120,130,160,.06);color:#8a8fa8;cursor:pointer;
    font:500 10px 'Manrope',sans-serif;transition:all .12s;
  }
  .ws-tb-btn:hover:not(:disabled){background:rgba(120,130,160,.14);color:#e0e2ea}
  .ws-tb-btn:disabled{opacity:.35;cursor:default}
  .ws-tree{
    display:flex;flex-direction:column;margin:0 8px;padding:4px;
    border-radius:8px;background:rgba(0,0,0,.18);
    border:1px solid rgba(120,130,160,.08);
  }
  .ws-row{
    display:flex;align-items:center;gap:6px;width:100%;padding:5px 8px 5px 6px;
    border:none;border-radius:5px;background:transparent;
    cursor:pointer;text-align:left;transition:background .1s,color .1s;
  }
  .ws-row:hover{background:rgba(120,130,160,.1)}
  .ws-more{cursor:default;color:#6a6f82;font:italic 500 11px 'Manrope',sans-serif}
  .ws-more:hover{background:transparent}
  .ws-guide{
    flex-shrink:0;width:9px;margin:-5px 5px -5px 6px;align-self:stretch;
    border-left:1px solid rgba(120,130,160,.16);
  }
  .ws-chev{
    flex-shrink:0;width:10px;font-size:9px;color:#6a6f82;
    display:inline-block;transition:transform .12s ease;line-height:1;
  }
  .ws-chev.open{transform:rotate(90deg)}
  .ws-chev-spacer{flex-shrink:0;width:10px}
  .ws-icon{font-size:12px;flex-shrink:0;line-height:1}
  .ws-name{
    flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    font:400 11px 'JetBrains Mono',monospace;color:#b8bdd2;
  }
  .ws-row:hover .ws-name{color:#e8ecf5}
  .ws-dirname{font:600 11px 'Manrope',sans-serif;color:#cdd2e4;letter-spacing:.01em}
  .ws-badge{
    flex-shrink:0;min-width:16px;padding:1px 6px;border-radius:8px;text-align:center;
    background:rgba(120,130,160,.12);color:#7a7f96;
    font:600 9px/14px 'JetBrains Mono',monospace;
  }
  .ws-size{color:#4a4f6a;font:400 10px 'JetBrains Mono',monospace;flex-shrink:0}
  .ws-file-view{display:flex;flex-direction:column;height:100%}
  .ws-file-header{
    display:flex;align-items:center;gap:8px;padding:8px 12px;
    border-bottom:1px solid rgba(120,130,160,.1);
  }
  .ws-back{
    padding:4px 10px;border-radius:5px;border:1px solid rgba(120,130,160,.2);
    background:rgba(120,130,160,.06);color:#8a8fa8;cursor:pointer;
    font:500 10px 'Manrope',sans-serif;transition:all .1s;
  }
  .ws-back:hover{background:rgba(120,130,160,.15);color:#fff}
  .ws-file-path{font:500 11px 'JetBrains Mono',monospace;color:#c0c5d8;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ws-file-lang{
    padding:2px 8px;border-radius:4px;flex-shrink:0;
    background:rgba(99,102,241,.14);border:1px solid rgba(99,102,241,.3);
    color:#a5a9ff;font:500 9px 'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.04em;
  }
  .ws-file-code{
    flex:1;overflow:auto;padding:12px 16px;margin:0;
    font:400 11px/1.5 'JetBrains Mono',monospace;color:#c0c5d8;
    background:rgba(0,0,0,.2);border-radius:0 0 8px 8px;
    white-space:pre;tab-size:2;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.2) transparent;
  }
  .ws-file-code code{display:block;min-width:max-content}
  /* Syntax highlighting — neutral dark palette */
  .ws-file-code :global(.hl-kw) { color:#c586c0; }
  .ws-file-code :global(.hl-str) { color:#ce9178; }
  .ws-file-code :global(.hl-num) { color:#b5cea8; }
  .ws-file-code :global(.hl-com) { color:#6a9955; font-style:italic; }
  .ws-file-code :global(.hl-fn)  { color:#dcdcaa; }
  .ws-file-code :global(.hl-typ) { color:#4ec9b0; }
  .ws-file-code :global(.hl-key) { color:#9cdcfe; }
  .ws-file-code :global(.hl-pun) { color:#9a9fb2; }

  /* Rendered-markdown view (when the file is .md). Mirrors the styles on
     the top-level /workspace page so proposals render readable, not raw. */
  .ws-file-md{
    flex:1;overflow:auto;padding:14px 18px;
    font:400 12.5px/1.65 'Manrope','Inter',sans-serif;color:#e8ecf5;
    background:rgba(0,0,0,.18);border-radius:0 0 8px 8px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.2) transparent;
  }
  .ws-file-md :global(h1),
  .ws-file-md :global(h2),
  .ws-file-md :global(h3),
  .ws-file-md :global(h4),
  .ws-file-md :global(h5),
  .ws-file-md :global(h6){ margin:1.2em 0 .4em; line-height:1.3; color:#f0f4ff; }
  .ws-file-md :global(h1){ font-size:18px; }
  .ws-file-md :global(h2){ font-size:15px; border-bottom:1px solid rgba(90,110,160,.18); padding-bottom:3px; }
  .ws-file-md :global(h3){ font-size:13px; color:#bcc7e5; }
  .ws-file-md :global(p){ margin:8px 0; }
  .ws-file-md :global(ul), .ws-file-md :global(ol){ padding-left:20px; margin:6px 0; }
  .ws-file-md :global(li){ margin:2px 0; }
  .ws-file-md :global(code){ background:rgba(90,110,160,.14); padding:1px 5px; border-radius:3px;
    font:90% 'JetBrains Mono',monospace; }
  .ws-file-md :global(pre.md-code){
    background:rgba(0,0,0,.32); border:1px solid rgba(90,110,160,.2);
    padding:10px 12px; border-radius:6px; overflow-x:auto; margin:10px 0;
    font:400 11px/1.5 'JetBrains Mono',monospace;
  }
  .ws-file-md :global(pre.md-code code){ background:transparent; padding:0; }
  .ws-file-md :global(blockquote){
    border-left:3px solid rgba(99,102,241,.5);
    margin:10px 0; padding:2px 12px;
    color:#a8b5d1; background:rgba(99,102,241,.06);
  }
  .ws-file-md :global(a){ color:#7c92ff; text-decoration:underline; }
  .ws-file-md :global(a:hover){ color:#a3b3ff; }
  .ws-file-md :global(table.md-table){ border-collapse:collapse; margin:10px 0; font-size:11.5px; }
  .ws-file-md :global(table.md-table th),
  .ws-file-md :global(table.md-table td){
    border:1px solid rgba(90,110,160,.2); padding:5px 9px; text-align:left;
  }
  .ws-file-md :global(table.md-table th){ background:rgba(90,110,160,.1); font-weight:600; }
  .ws-file-md :global(hr){ border:none; border-top:1px solid rgba(90,110,160,.2); margin:16px 0; }

  /* ── Agent files vs the repo: one colour each, everywhere ── */
  .ws-sections{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0 8px 10px}
  .ws-sec{
    display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:9px;cursor:pointer;text-align:left;
    border:1px solid rgba(120,130,160,.18);background:rgba(120,130,160,.05);color:#8a8fa8;
    transition:background .15s,border-color .15s,color .15s;
  }
  .ws-sec:hover{background:rgba(120,130,160,.1);color:#d0d4e4}
  .ws-sec-txt{display:flex;flex-direction:column;min-width:0;flex:1}
  .ws-sec-txt b{font:700 12px 'Manrope',sans-serif;color:inherit}
  .ws-sec-txt small{font:500 10px 'Manrope',sans-serif;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ws-sec-n{flex-shrink:0;min-width:20px;padding:1px 7px;border-radius:9px;text-align:center;font:700 10px/16px 'JetBrains Mono',monospace;background:rgba(120,130,160,.14)}
  .ws-sec-agent.on{background:rgba(167,139,250,.14);border-color:rgba(167,139,250,.55);color:#d8ccff}
  .ws-sec-agent.on .ws-sec-n{background:rgba(167,139,250,.3);color:#efe9ff}
  .ws-sec-repo.on{background:rgba(45,212,191,.12);border-color:rgba(45,212,191,.5);color:#a7f3e6}
  .ws-sec:focus-visible{outline:2px solid #a78bfa;outline-offset:2px}

  .ws-card-title{display:flex;flex-direction:column;gap:1px;font:700 12px 'Manrope',sans-serif;color:#e8ecf5}
  .ws-card-title span{font:500 10.5px 'Manrope',sans-serif;color:#9aa0b8}
  .ws-card-agent{background:linear-gradient(180deg,rgba(167,139,250,.12),rgba(167,139,250,.03));border-color:rgba(167,139,250,.3)}
  .ws-card-agent .ws-cwd-lbl{background:rgba(167,139,250,.22);color:#d0c2ff}
  .ws-card-repo{background:linear-gradient(180deg,rgba(45,212,191,.1),rgba(45,212,191,.02));border-color:rgba(45,212,191,.28)}
  .ws-card-repo > .ws-cwd-row:not(.ws-cwd-guard):not(.ws-cwd-extra) .ws-cwd-lbl{background:rgba(45,212,191,.2);color:#99eedd}

  .ws-tree-agent{border-color:rgba(167,139,250,.22);box-shadow:inset 3px 0 0 rgba(167,139,250,.55)}
  .ws-tree-repo{border-color:rgba(45,212,191,.2);box-shadow:inset 3px 0 0 rgba(45,212,191,.5)}
  .ws-origin{
    flex-shrink:0;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.05em;
    font:700 9px 'JetBrains Mono',monospace;background:rgba(167,139,250,.2);color:#d8ccff;border:1px solid rgba(167,139,250,.45);
  }
  .ws-origin.repo{background:rgba(45,212,191,.16);color:#99eedd;border-color:rgba(45,212,191,.42)}
  @media (prefers-reduced-motion: reduce){ .ws-sec{transition:none} }
</style>

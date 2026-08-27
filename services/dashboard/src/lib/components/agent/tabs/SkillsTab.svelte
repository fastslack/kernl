<!--
  SkillsTab — the one screen where an agent's skills are decided.

  Before this tab, "get a skill" and "give it to this agent" were two
  different screens: /extensions installs, and AgentSkillsPanel (mounted only
  on /agents, despite its own comment claiming otherwise) attaches what is
  already installed. The 3D drawer had neither. So the answer to "this agent
  should know how to do X" was: leave the agent, find X in a catalogue of
  ~500, install it, come back, open a picker, find it again.

  Three zones, ordered by how often they are used:

    ATTACHED     what this agent carries right now
    RECOMMENDED  ranked for THIS agent by GET /api/agents/:id/skill-suggestions
    SEARCH       the whole catalogue, for the rare case

  RECOMMENDED spans installed skills AND catalogue skills from subscribed
  repos. A row that is not installed yet gets [↓+] — install, then attach —
  which is what makes this an installer and not a wishlist. The ranking is
  deterministic keyword+IDF overlap computed by the kernel; nothing here
  calls a model, and nothing here attaches without a click.

  ── The two token numbers ──────────────────────────────────────────────
  The header's figure is the FIXED toll: the executor writes one index line
  per attached skill into the system prompt on every single run, used or not.
  Each row's figure is the VARIABLE one — what the body costs IF the model
  calls `kernel_skill_load`. They differ by two orders of magnitude and
  neither was visible anywhere before. Attaching fifteen skills "just in
  case" should stop looking free.

  ── Three states, not two ─────────────────────────────────────────────
  An attached slug can be live, INACTIVE, or ORPHANED. SkillBodyResolver
  accepts `status IN ('active','installed')`, but the shared
  `loadInstalledSkills()` asks the API for `status=active` only — so
  classifying orphans off that one list flags a merely-inactive skill as
  uninstalled, which is a lie the user would act on by detaching a skill that
  works. Hence the second, wider inventory fetch below.

  Props:
    agent    — { id, name, skills_json, … }; null renders nothing
    compact  — denser type for the narrow drawer

  Events:
    change   — { skills: string[] } after a successful save, so whoever
               mounted the drawer can patch its own copy without a refetch
-->
<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import {
    loadInstalledSkills,
    parseAttachedSkills,
    saveAgentSkills,
    estimateSkillTokens,
    skillDescription,
    skillIndexTokens,
    invalidateSkillsCache,
    SKILL_INDEX_PREAMBLE_TOKENS,
    type SkillItem,
    type SkillAgent
  } from '$lib/skills.js';

  export let agent: (SkillAgent & Record<string, unknown>) | null = null;
  export let compact = false;

  const dispatch = createEventDispatcher<{ change: { skills: string[] } }>();

  // ── Attached ──────────────────────────────────────────────────────
  // Owned locally rather than derived straight off the prop: a save has to
  // show immediately, and whoever mounted the drawer may or may not echo
  // `skills_json` back. Re-seeded when the agent changes, and when the prop's
  // own value moves (an attach made in the /agents panel — until Task 13
  // those are two components over one backend).
  let attached: string[] = [];
  let seededId = '';
  let seenJson = '';

  function syncAttached(a: SkillAgent | null): void {
    if (!a) return;
    const j = a.skills_json ?? '[]';
    if (a.id !== seededId) {
      seededId = a.id;
      seenJson = j;
      attached = parseAttachedSkills(a);
      resetForAgent();
    } else if (j !== seenJson) {
      seenJson = j;
      attached = parseAttachedSkills(a);
    }
  }
  $: syncAttached(agent);

  // ── Inventory ─────────────────────────────────────────────────────
  /** Active installed skills — through the shared cache the other surfaces read. */
  let installed: SkillItem[] = [];
  /** Every installed skill row, any status. Used only to classify. */
  let inventory: SkillItem[] = [];
  let inventoryLoaded = false;
  let inventoryLoading = false;
  let inventoryError = '';

  $: activeSlugs = new Set(installed.map((s) => s.slug));
  $: bySlug = new Map(inventory.map((s) => [s.slug, s]));

  /** Attached, installed, but not active — the executor still loads it. */
  $: inactiveSlugs = inventoryLoaded && !inventoryError
    ? attached.filter((s) => !activeSlugs.has(s) && bySlug.has(s))
    : [];
  /**
   * Attached with no extension row at all: the skill was uninstalled while
   * still attached. The executor drops it in silence, so this tab is the only
   * place it is visible. (Same detection as AgentSkillsPanel.svelte:59,
   * widened so an inactive row no longer counts as a missing one.)
   */
  $: orphans = inventoryLoaded && !inventoryError
    ? attached.filter((s) => !bySlug.has(s))
    : [];

  async function loadInventory(): Promise<void> {
    inventoryLoading = true;
    inventoryError = '';
    try {
      // Two calls on purpose — see the header comment. The first goes through
      // the shared module cache, so an install made here shows up in /agents
      // and in the /extensions hub; the second is the wider status set the
      // executor actually honours.
      const [active, all] = await Promise.all([
        loadInstalledSkills(),
        (async () => {
          const r = await fetch('/api/extensions?type=skill');
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = await r.json();
          return (body.items ?? []) as SkillItem[];
        })()
      ]);
      installed = active;
      inventory = all;
    } catch (e) {
      // A failed fetch and an empty kernel look identical downstream, and one
      // of them would paint every attached skill as an orphan.
      inventoryError = (e as Error).message;
      inventory = [];
    } finally {
      inventoryLoading = false;
      inventoryLoaded = true;
    }
  }

  // ── Recommendations ───────────────────────────────────────────────
  type Suggestion = {
    slug: string;
    name: string;
    score: number;
    matches: string[];
    installed: boolean;
  };

  let suggestions: Suggestion[] = [];
  let sugLoading = false;
  let sugError = '';
  /** The kernel serving this dashboard predates the route. */
  let sugUnsupported = false;
  let sugFor = '';

  async function loadSuggestions(id: string): Promise<void> {
    sugLoading = true;
    sugError = '';
    sugUnsupported = false;
    suggestions = [];
    try {
      const r = await fetch(
        `/api/agents/${encodeURIComponent(id)}/skill-suggestions?min_score=1&top_n=12`
      );
      const body = (await r.json().catch(() => ({}))) as {
        error?: string;
        suggestions?: Suggestion[];
      };
      if (!r.ok) {
        // 404 is two different things here. The route itself answers
        // "agent not found"; a kernel built before the route exists answers
        // the server's own "Not found". Reporting the second as "no
        // suggestions" would blame the ranking for a deployment gap.
        if (r.status === 404 && !/agent not found/i.test(String(body.error ?? ''))) {
          sugUnsupported = true;
          return;
        }
        throw new Error(String(body.error ?? `HTTP ${r.status}`));
      }
      suggestions = (body.suggestions ?? []) as Suggestion[];
    } catch (e) {
      sugError = (e as Error).message;
      suggestions = [];
    } finally {
      sugLoading = false;
    }
  }

  /**
   * The kernel filtered out what was attached WHEN IT RANKED. Anything
   * attached since has to go too, or [+] would leave its own row behind.
   */
  $: recommended = suggestions.filter((s) => !attached.includes(s.slug));

  /**
   * Six by default. Twelve ranked rows push SEARCH THE CATALOGUE off the
   * bottom of a drawer that is already sharing the screen with a 3D world —
   * observed while verifying this tab. The rest are one click away.
   */
  const REC_PREVIEW = 6;
  let showAllRecs = false;
  $: visibleRecs = showAllRecs ? recommended : recommended.slice(0, REC_PREVIEW);

  // ── Catalogue search ──────────────────────────────────────────────
  type CatalogEntry = {
    id: string;
    slug: string;
    status?: string;
    manifest?: { name?: string; description?: string };
  };

  let search = '';
  let results: CatalogEntry[] = [];
  let searching = false;
  let searchError = '';
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  /** The query `results` belongs to, so a slow response cannot overwrite a newer one. */
  let searchedFor = '';

  function onSearchInput(): void {
    if (searchDebounce) clearTimeout(searchDebounce);
    const q = search;
    searchDebounce = setTimeout(() => void runSearch(q), 250);
  }

  async function runSearch(q: string): Promise<void> {
    const query = q.trim();
    if (!query) {
      searchedFor = '';
      results = [];
      searchError = '';
      searching = false;
      return;
    }
    searching = true;
    searchError = '';
    try {
      const r = await fetch(
        `/api/marketplace/catalog?type=skill&q=${encodeURIComponent(query)}&limit=40`
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (q !== search) return; // a newer keystroke already won
      searchedFor = query;
      results = (body.items ?? []) as CatalogEntry[];
    } catch (e) {
      if (q !== search) return;
      searchError = (e as Error).message;
      results = [];
    } finally {
      if (q === search) searching = false;
    }
  }

  $: searchRows = results.filter((e) => !attached.includes(e.slug));

  // ── Writing ───────────────────────────────────────────────────────
  /** Per-row state, so a failure lands on the row that caused it, not in a toast. */
  let busy: Record<string, string> = {};
  let rowError: Record<string, string> = {};

  function setBusy(slug: string, label: string): void {
    if (label) busy[slug] = label;
    else delete busy[slug];
    busy = { ...busy };
  }
  function setRowError(slug: string, msg: string): void {
    if (msg) rowError[slug] = msg;
    else delete rowError[slug];
    rowError = { ...rowError };
  }

  /** Persist the slug list. Returns '' on success, the error message otherwise. */
  async function persist(next: string[]): Promise<string> {
    if (!agent) return 'No agent';
    try {
      await saveAgentSkills(agent.id, next);
      attached = next;
      // Keep our record of the prop in step with what we just wrote, so the
      // parent echoing it back is a no-op instead of a re-seed.
      seenJson = JSON.stringify(next);
      dispatch('change', { skills: next });
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  }

  async function attach(slug: string): Promise<void> {
    if (attached.includes(slug)) return;
    setRowError(slug, '');
    setBusy(slug, 'attaching');
    try {
      setRowError(slug, await persist([...attached, slug]));
    } finally {
      setBusy(slug, '');
    }
  }

  async function detach(slug: string): Promise<void> {
    setRowError(slug, '');
    setBusy(slug, 'detaching');
    try {
      setRowError(slug, await persist(attached.filter((s) => s !== slug)));
    } finally {
      setBusy(slug, '');
    }
  }

  /**
   * [↓+] — install, THEN attach. The order is load-bearing: attaching a slug
   * whose install failed writes exactly the orphan the top zone warns about.
   * So a failed install shows on the row and stops here.
   *
   * `idOrSlug`: the catalog registry resolves either (registry.getItem matches
   * `i.id === x || i.slug === x`), and the suggestions route only knows slugs
   * — so a suggestion posts its slug and a search result posts its id.
   *
   * Installing can clone a git repo, hence the explicit busy label.
   */
  async function installAndAttach(slug: string, idOrSlug: string): Promise<void> {
    setRowError(slug, '');
    setBusy(slug, 'installing');
    try {
      const r = await fetch('/api/marketplace/catalog/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: idOrSlug })
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(String(body.error ?? `HTTP ${r.status}`));

      // The shared cache is now stale for every surface, not only this one.
      invalidateSkillsCache();
      await loadInventory();
      if (inventoryError) {
        // We cannot prove the row landed. Attaching blind is how orphans are
        // born, so stop and say why.
        throw new Error(`Installed, but the extension list did not reload (${inventoryError})`);
      }
      if (!bySlug.has(slug)) {
        throw new Error('Install reported success but no extension with that slug appeared.');
      }

      setBusy(slug, 'attaching');
      const err = await persist([...attached, slug]);
      if (err) setRowError(slug, `Installed, but the attach failed: ${err}`);
      else void refreshSearchStatus();
    } catch (e) {
      setRowError(slug, (e as Error).message);
    } finally {
      setBusy(slug, '');
    }
  }

  /** After an install the catalogue's `status` column is stale. */
  async function refreshSearchStatus(): Promise<void> {
    if (searchedFor) await runSearch(search);
  }

  // ── Costs ─────────────────────────────────────────────────────────
  /** Fixed, paid on every run: the index block the executor injects. */
  $: indexCost = attached.length
    ? SKILL_INDEX_PREAMBLE_TOKENS +
      attached.reduce((sum, slug) => {
        const item = bySlug.get(slug);
        // An orphan contributes nothing — the resolver drops it before the
        // index is built, which is the one upside of being broken.
        return item ? sum + skillIndexTokens(slug, skillDescription(item)) : sum;
      }, 0)
    : 0;

  function bodyCost(slug: string): number {
    const item = bySlug.get(slug);
    return item ? estimateSkillTokens(item) : 0;
  }

  function fmtTok(n: number): string {
    if (!n) return '0';
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  function descOf(slug: string): string {
    const item = bySlug.get(slug);
    return item ? skillDescription(item) : '';
  }

  // ── Lifecycle ─────────────────────────────────────────────────────
  function resetForAgent(): void {
    suggestions = [];
    showAllRecs = false;
    sugFor = '';
    busy = {};
    rowError = {};
  }

  // Inventory is kernel-wide (load once); suggestions are per agent.
  $: if (agent && !inventoryLoaded && !inventoryLoading) void loadInventory();
  $: if (agent && agent.id !== sugFor) {
    sugFor = agent.id;
    void loadSuggestions(agent.id);
  }

  onDestroy(() => {
    if (searchDebounce) clearTimeout(searchDebounce);
  });

  /** Nothing at all installed — offer the catalogue instead of an empty box. */
  $: emptyInventory = inventoryLoaded && !inventoryError && inventory.length === 0;
</script>

{#if agent}
  <div class="sk" class:sk-compact={compact}>
    <!-- ═══ ATTACHED ═══ -->
    <section class="sk-zone">
      <header class="sk-zh">
        <h3 class="sk-h">
          Attached
          {#if attached.length}<span class="sk-c">{attached.length}</span>{/if}
        </h3>
        <span
          class="sk-toll"
          class:sk-toll-hot={indexCost >= 400}
          title="What these skills cost on EVERY run. The executor writes one index line per attached skill into the system prompt whether the skill is used or not. The body is only read when the model calls kernel_skill_load — that is the per-row figure."
        >
          {indexCost ? `~${fmtTok(indexCost)} tok / run` : 'no per-run cost'}
        </span>
      </header>

      {#if attached.length === 0}
        <p class="sk-empty">
          This agent carries no skills. A skill is a markdown playbook it can read
          mid-run; attaching one adds a single line to its system prompt on every
          run, and the playbook itself is only paid for when the agent opens it.
        </p>
      {:else}
        <ul class="sk-list">
          {#each attached as slug (slug)}
            {@const item = bySlug.get(slug)}
            {@const isOrphan = orphans.includes(slug)}
            {@const isInactive = inactiveSlugs.includes(slug)}
            <li class="sk-row" class:sk-row-orphan={isOrphan} class:sk-row-warn={isInactive}>
              <span class="sk-glyph" aria-hidden="true"
                >{isOrphan ? '⚠' : isInactive ? '◐' : '▸'}</span
              >
              <span class="sk-main">
                <span class="sk-slug">{slug}</span>
                {#if isOrphan}
                  <span class="sk-note sk-note-bad">not installed — every run skips it</span>
                {:else if isInactive}
                  <span class="sk-note sk-note-warn">installed but not active</span>
                {:else if item && skillDescription(item)}
                  <span class="sk-desc">{skillDescription(item)}</span>
                {/if}
              </span>
              {#if item}
                <span
                  class="sk-cost"
                  title="Tokens the full body costs IF the model calls kernel_skill_load. Not paid until then."
                >
                  ~{fmtTok(bodyCost(slug))} if loaded
                </span>
              {/if}
              <button
                class="sk-x"
                title="Detach"
                on:click={() => detach(slug)}
                disabled={!!busy[slug]}>{busy[slug] === 'detaching' ? '…' : '×'}</button
              >
            </li>
            {#if rowError[slug]}
              <li class="sk-rowerr">{rowError[slug]}</li>
            {/if}
          {/each}
        </ul>
        {#if orphans.length}
          <p class="sk-warn">
            {orphans.length} attached slug{orphans.length === 1 ? '' : 's'} ({orphans.join(', ')})
            {orphans.length === 1 ? 'has' : 'have'} no installed extension. The executor drops
            {orphans.length === 1 ? 'it' : 'them'} silently on every run — detach, or install
            {orphans.length === 1 ? 'it' : 'them'} from the catalogue below.
          </p>
        {/if}
      {/if}

      {#if inventoryError}
        <p class="sk-err">
          Could not read the installed skills ({inventoryError}) — the marks above cannot be
          trusted until this loads.
        </p>
      {/if}
    </section>

    <!-- ═══ RECOMMENDED ═══ -->
    <section class="sk-zone">
      <header class="sk-zh">
        <h3 class="sk-h">Recommended for this agent</h3>
        <span
          class="sk-hint"
          title="Deterministic keyword + IDF overlap between this agent's prompt and each skill's text. No model is called."
        >
          ranked, not generated
        </span>
      </header>

      {#if sugUnsupported}
        <p class="sk-empty">
          This kernel has no <code>/api/agents/:id/skill-suggestions</code> route, so there is
          nothing to rank with. Search the catalogue below instead.
        </p>
      {:else if sugLoading}
        <p class="sk-empty">Scoring the catalogue against this agent's prompt…</p>
      {:else if sugError}
        <p class="sk-err">Could not load recommendations: {sugError}</p>
      {:else if recommended.length === 0}
        <p class="sk-empty">
          Nothing scored above the floor for this agent. That usually means the system prompt is
          short, or no subscribed repo overlaps with it — search below.
        </p>
      {:else}
        <ul class="sk-list">
          {#each visibleRecs as s (s.slug)}
            <li class="sk-row">
              <span class="sk-score" title="Keyword overlap against this agent's prompt"
                >{s.score.toFixed(1)}</span
              >
              <span class="sk-main">
                <span class="sk-slug">
                  {s.slug}
                  {#if !s.installed}<span class="sk-tag">catalogue</span>{/if}
                </span>
                {#if s.matches?.length}
                  <span class="sk-matches">
                    {#each s.matches.slice(0, 5) as m}<span class="sk-match">{m}</span>{/each}
                  </span>
                {:else if descOf(s.slug)}
                  <span class="sk-desc">{descOf(s.slug)}</span>
                {/if}
              </span>
              {#if s.installed}
                <span class="sk-cost">~{fmtTok(bodyCost(s.slug))} if loaded</span>
                <button
                  class="sk-add"
                  title="Attach — already installed"
                  on:click={() => attach(s.slug)}
                  disabled={!!busy[s.slug]}>{busy[s.slug] ? '…' : '+'}</button
                >
              {:else}
                <button
                  class="sk-add sk-add-dl"
                  title="Install this skill, then attach it"
                  on:click={() => installAndAttach(s.slug, s.slug)}
                  disabled={!!busy[s.slug]}
                  >{busy[s.slug] === 'installing' ? '… installing' : busy[s.slug] ? '…' : '↓+'}</button
                >
              {/if}
            </li>
            {#if rowError[s.slug]}
              <li class="sk-rowerr">{rowError[s.slug]}</li>
            {/if}
          {/each}
        </ul>
        {#if recommended.length > REC_PREVIEW}
          <button class="sk-more" on:click={() => (showAllRecs = !showAllRecs)}>
            {showAllRecs
              ? 'show fewer'
              : `show ${recommended.length - REC_PREVIEW} more ranked below the top ${REC_PREVIEW}`}
          </button>
        {/if}
      {/if}

      {#if emptyInventory}
        <p class="sk-empty">
          No skills are installed on this kernel yet. A <em>catalogue</em> row installs itself
          when you attach it — nothing has to be set up first. Whole repositories are subscribed
          in <a href="/extensions?tab=skills">Extensions → Skills</a>.
        </p>
      {/if}
    </section>

    <!-- ═══ SEARCH ═══ -->
    <section class="sk-zone">
      <header class="sk-zh">
        <h3 class="sk-h">Search the catalogue</h3>
        {#if searching}<span class="sk-hint">searching…</span>{/if}
      </header>

      <input
        class="sk-search"
        type="text"
        bind:value={search}
        on:input={onSearchInput}
        placeholder="Search every subscribed repo by slug, name or description…"
      />

      {#if searchError}
        <p class="sk-err">Catalogue search failed: {searchError}</p>
      {:else if searchedFor && searchRows.length === 0 && !searching}
        <p class="sk-empty">No skill matches “{searchedFor}”.</p>
      {:else if searchRows.length}
        <ul class="sk-list">
          {#each searchRows as e (e.id)}
            {@const isInstalled = bySlug.has(e.slug)}
            {@const paid = e.status === 'for_sale'}
            <li class="sk-row">
              <span class="sk-glyph" aria-hidden="true">{isInstalled ? '▸' : '⬇'}</span>
              <span class="sk-main">
                <span class="sk-slug">
                  {e.slug}
                  {#if paid}<span class="sk-tag sk-tag-paid">paid</span>{/if}
                </span>
                {#if e.manifest?.description}
                  <span class="sk-desc">{e.manifest.description}</span>
                {/if}
              </span>
              {#if paid}
                <a class="sk-buy" href="/extensions?tab=skills">get it →</a>
              {:else if isInstalled}
                <span class="sk-cost">~{fmtTok(bodyCost(e.slug))} if loaded</span>
                <button
                  class="sk-add"
                  title="Attach — already installed"
                  on:click={() => attach(e.slug)}
                  disabled={!!busy[e.slug]}>{busy[e.slug] ? '…' : '+'}</button
                >
              {:else}
                <button
                  class="sk-add sk-add-dl"
                  title="Install this skill, then attach it"
                  on:click={() => installAndAttach(e.slug, e.id)}
                  disabled={!!busy[e.slug]}
                  >{busy[e.slug] === 'installing' ? '… installing' : busy[e.slug] ? '…' : '↓+'}</button
                >
              {/if}
            </li>
            {#if rowError[e.slug]}
              <li class="sk-rowerr">{rowError[e.slug]}</li>
            {/if}
          {/each}
        </ul>
      {/if}
    </section>
  </div>
{/if}

<style>
  .sk {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .sk-compact {
    gap: 14px;
  }

  .sk-zone {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sk-zh {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  .sk-h {
    margin: 0;
    font: 700 10px/1 'JetBrains Mono', monospace;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #8b93aa;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sk-c {
    font: 700 9px/1 'JetBrains Mono', monospace;
    color: #0a0e14;
    background: #9fb4e8;
    border-radius: 99px;
    padding: 2px 5px;
  }
  .sk-hint {
    font: 500 9.5px 'JetBrains Mono', monospace;
    color: #6a6f82;
    cursor: help;
  }
  .sk-toll {
    font: 600 10px 'JetBrains Mono', monospace;
    color: #9fb4e8;
    cursor: help;
    border: 1px solid rgba(120, 170, 255, 0.28);
    background: rgba(120, 170, 255, 0.07);
    border-radius: 99px;
    padding: 2px 8px;
    white-space: nowrap;
  }
  .sk-toll-hot {
    color: #fbbf24;
    border-color: rgba(251, 191, 36, 0.34);
    background: rgba(251, 191, 36, 0.08);
  }

  .sk-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .sk-row {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid rgba(120, 130, 160, 0.16);
    background: rgba(20, 24, 38, 0.5);
  }
  .sk-row-warn {
    border-color: rgba(251, 191, 36, 0.3);
    background: rgba(251, 191, 36, 0.05);
  }
  .sk-row-orphan {
    border-color: rgba(239, 93, 110, 0.35);
    background: rgba(239, 93, 110, 0.06);
  }

  .sk-glyph {
    flex: none;
    width: 12px;
    text-align: center;
    color: #6a6f82;
    font-size: 11px;
  }
  .sk-row-orphan .sk-glyph {
    color: #ef5d6e;
  }
  .sk-row-warn .sk-glyph {
    color: #fbbf24;
  }

  .sk-score {
    flex: none;
    min-width: 34px;
    text-align: right;
    cursor: help;
    font: 700 11px 'JetBrains Mono', monospace;
    color: #9fb4e8;
  }

  .sk-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sk-slug {
    font: 600 11.5px 'JetBrains Mono', monospace;
    color: #d8dae3;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sk-desc {
    font: 500 10.5px/1.35 'Manrope', sans-serif;
    color: #6a6f82;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sk-note {
    font: 600 9.5px 'JetBrains Mono', monospace;
  }
  .sk-note-bad {
    color: #ef5d6e;
  }
  .sk-note-warn {
    color: #fbbf24;
  }

  .sk-matches {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .sk-match {
    font: 500 9px 'JetBrains Mono', monospace;
    color: #8b93aa;
    border: 1px solid rgba(120, 130, 160, 0.22);
    border-radius: 3px;
    padding: 1px 4px;
  }

  .sk-tag {
    font: 600 8.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #8b93aa;
    border: 1px solid rgba(120, 130, 160, 0.3);
    border-radius: 3px;
    padding: 1px 4px;
  }
  .sk-tag-paid {
    color: #fbbf24;
    border-color: rgba(251, 191, 36, 0.4);
  }

  .sk-cost {
    flex: none;
    cursor: help;
    font: 500 9.5px 'JetBrains Mono', monospace;
    color: #6a6f82;
    white-space: nowrap;
  }

  .sk-add,
  .sk-x {
    flex: none;
    cursor: pointer;
    border-radius: 5px;
    border: 1px solid rgba(120, 130, 160, 0.3);
    background: rgba(26, 31, 48, 0.8);
    color: #a9bcf0;
    font: 700 11px 'JetBrains Mono', monospace;
    padding: 3px 8px;
  }
  .sk-add:hover:not(:disabled) {
    color: #0a0e14;
    background: #9fb4e8;
    border-color: #9fb4e8;
  }
  .sk-add-dl {
    color: #7fd1a8;
    border-color: rgba(127, 209, 168, 0.32);
  }
  .sk-add-dl:hover:not(:disabled) {
    color: #0a0e14;
    background: #7fd1a8;
    border-color: #7fd1a8;
  }
  .sk-add:disabled,
  .sk-x:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .sk-x {
    color: #8b93aa;
    padding: 3px 7px;
  }
  .sk-x:hover:not(:disabled) {
    color: #ef5d6e;
    border-color: rgba(239, 93, 110, 0.4);
    background: rgba(239, 93, 110, 0.1);
  }

  .sk-more {
    align-self: flex-start;
    cursor: pointer;
    background: none;
    border: none;
    padding: 2px 0;
    font: 500 10px 'JetBrains Mono', monospace;
    color: #a9bcf0;
  }
  .sk-more:hover {
    text-decoration: underline;
  }

  .sk-buy {
    flex: none;
    font: 600 10px 'JetBrains Mono', monospace;
    color: #fbbf24;
    text-decoration: none;
  }
  .sk-buy:hover {
    text-decoration: underline;
  }

  .sk-search {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid rgba(120, 130, 160, 0.28);
    border-radius: 6px;
    background: rgba(14, 18, 30, 0.85);
    color: #d8dae3;
    font: 500 11.5px 'JetBrains Mono', monospace;
    padding: 7px 9px;
  }
  .sk-search:focus {
    outline: none;
    border-color: rgba(120, 170, 255, 0.55);
  }
  .sk-search::placeholder {
    color: #535a6e;
  }

  .sk-empty {
    margin: 0;
    font: 500 10.5px/1.5 'Manrope', sans-serif;
    color: #6a6f82;
  }
  .sk-empty a {
    color: #a9bcf0;
  }
  .sk-empty code {
    font: 500 10px 'JetBrains Mono', monospace;
    color: #8b93aa;
  }
  .sk-warn {
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid rgba(239, 93, 110, 0.28);
    background: rgba(239, 93, 110, 0.07);
    font: 500 10.5px/1.45 'Manrope', sans-serif;
    color: #ef8f9b;
  }
  .sk-err {
    margin: 0;
    font: 500 10.5px/1.4 'Manrope', sans-serif;
    color: #ef5d6e;
  }
  .sk-rowerr {
    list-style: none;
    margin: -1px 0 2px 30px;
    font: 500 10px/1.4 'Manrope', sans-serif;
    color: #ef5d6e;
  }
</style>

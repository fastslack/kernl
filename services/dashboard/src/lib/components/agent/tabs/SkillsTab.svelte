<!--
  SkillsTab — the one screen where an agent's skills are decided.

  Before this tab, "get a skill" and "give it to this agent" were two
  different screens: /extensions installs, and a separate attach-only panel
  (mounted on /agents and on the 2D agent list, despite its own comment
  claiming it was shared with the 3D drawer) picked from what was already
  installed. The 3D drawer had neither. So the answer to "this agent should
  know how to do X" was: leave the agent, find X in a catalogue of ~500,
  install it, come back, open a picker, find it again. That panel is gone;
  this tab is the only one left.

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

  ── Four states, not two ──────────────────────────────────────────────
  An attached slug can be LIVE (active), INACTIVE (installed but not yet
  active — still live), SKIPPED (disabled/error — an extension row exists
  but the executor won't touch it), or ORPHANED (no row at all).
  SkillBodyResolver.resolve() accepts exactly `status IN ('active',
  'installed')` (skill-resolver.ts:65); anything else — disabled, error, or
  a status this tab doesn't recognise — is dropped by the SAME clause an
  orphan is dropped by, and must be priced and labelled as such. The shared
  `loadInstalledSkills()` asks the API for `status=active` only, so
  classifying off that one list would flag a merely-inactive skill as
  uninstalled (a lie the user would act on by detaching something that
  works) — hence the second, wider inventory fetch below, which is also what
  makes SKIPPED distinguishable from LIVE in the first place.

  Props:
    agent    — { id, name, skills_json, … }; null renders nothing
    compact  — denser type for the narrow drawer

  Events:
    change   — { skills: string[] } after a successful save, so whoever
               mounted the drawer can patch its own copy without a refetch
-->
<script lang="ts">
  import { t } from '$lib/i18n/index.js';
  import { createEventDispatcher, onDestroy } from 'svelte';
  import {
    loadInstalledSkills,
    parseAttachedSkills,
    saveAgentSkills,
    estimateSkillTokens,
    skillDescription,
    skillIndexTokens,
    invalidateSkillsCache,
    subscribeRepo,
    loadRepoSkills,
    SKILL_INDEX_PREAMBLE_TOKENS,
    type SkillItem,
    type SkillAgent,
    type CatalogSkill
  } from '$lib/skills.js';
  import { normalizeRepoUrl } from '$lib/skill-repos.js';

  // `SkillAgent` and nothing more: this tab reads `id`, `name` and
  // `skills_json`, and the three surfaces that mount it each hand over a
  // differently-shaped row (a raw list row, the drawer's merged one, the flow
  // page's `AgentData` interface). Intersecting with `Record<string, unknown>`
  // rejected the last of those for no gain — an interface has no index
  // signature — while widening nothing this file actually uses.
  export let agent: SkillAgent | null = null;
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

  $: bySlug = new Map(inventory.map((s) => [s.slug, s]));

  /**
   * Statuses SkillBodyResolver.resolve() actually loads — its WHERE clause
   * is `status IN ('active','installed')` (skill-resolver.ts:65). Anything
   * else present in the inventory (disabled, error, or a status this list
   * doesn't know about) is skipped by the executor exactly like an
   * uninstalled skill, and must not be priced or labelled as loaded.
   */
  const LIVE_STATUSES = new Set(['active', 'installed']);
  function isLive(item: SkillItem | undefined): item is SkillItem {
    return !!item && LIVE_STATUSES.has(item.status ?? '');
  }

  /** Attached, status='installed' (not yet 'active') — the executor still loads it. */
  $: inactiveSlugs = inventoryLoaded && !inventoryError
    ? attached.filter((s) => bySlug.get(s)?.status === 'installed')
    : [];
  /**
   * Attached, an extension row exists, but its status is outside what the
   * resolver accepts (disabled, error, …). The executor skips these on every
   * run exactly like an orphan — the row just happens to still exist. These
   * were previously lumped in with "installed but not active" and billed for,
   * which reported a broken skill as working.
   */
  $: skippedSlugs = inventoryLoaded && !inventoryError
    ? attached.filter((s) => { const item = bySlug.get(s); return !!item && !isLive(item); })
    : [];
  /**
   * Attached with no extension row at all: the skill was uninstalled while
   * still attached. The executor drops it in silence, so this tab is the only
   * place it is visible. It is the check the deleted attach-only panel made
   * against the active-only list, widened here so a merely inactive row no
   * longer counts as a missing one.
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

  // ── Add a repo by URL ─────────────────────────────────────────────
  // The search above can only offer what some subscribed repo already
  // carries, and subscribing used to live only on /extensions — so the
  // answer to "this agent should know three.js" was: leave the agent, add
  // the repo over there, come back and search again. This is that same POST,
  // one screen earlier.
  //
  // What it deliberately does NOT do is manage repos. Sync, unsubscribe and
  // install-all stay on /extensions: this tab decides one agent's skills, it
  // is not a second catalogue admin screen.
  //
  // A skill is text that goes into the model's prompt, so a box that accepts
  // any URL is a box that loads a stranger's instructions. `prompt-sanitizer`
  // scrubs what it can and that is not the same as the content being safe —
  // hence the caution line in the form.
  let showAddRepo = false;
  let repoUrl = '';
  let repoRef = '';
  let repoBusy = false;
  let repoError = '';
  let repoNotice = '';
  /**
   * "Already subscribed" and "this repo has no skills" are both notices, but
   * only one of them is a problem. Rendering both in the error red said the
   * ordinary case had gone wrong.
   */
  let repoNoticeKind: 'info' | 'warn' = 'warn';
  let repoSkills: CatalogSkill[] = [];
  let repoLabel = '';

  /** "cloudai-x/threejs-skills" — the half of a clone URL worth a heading. */
  function repoDisplayName(url: string): string {
    const parts = normalizeRepoUrl(url).split('/').filter(Boolean);
    return parts.slice(-2).join('/') || url;
  }

  async function addRepo(): Promise<void> {
    const url = repoUrl.trim();
    if (!url || repoBusy) return;
    repoBusy = true;
    repoError = '';
    repoNotice = '';
    repoSkills = [];
    try {
      const sub = await subscribeRepo(url, repoRef);
      repoLabel = repoDisplayName(url);
      // Zero found is the "awesome list" case: a README of links whose
      // targets live in other repositories. It clones cleanly and reports
      // success, so without this the screen just looks unchanged.
      if (sub.itemsFound === 0) {
        repoNoticeKind = 'warn';
        repoNotice = $t('agent.skills.repo_no_skills');
        return;
      }
      repoSkills = await loadRepoSkills(url);
      // Counted items but none of them skills — a repo of plugins, offices
      // or themes. Say so instead of an empty heading under a success line.
      if (repoSkills.length === 0) {
        repoNoticeKind = 'warn';
        repoNotice = $t('agent.skills.repo_no_skills');
      } else if (sub.alreadySubscribed) {
        repoNoticeKind = 'info';
        repoNotice = $t('agent.skills.repo_already');
      }
    } catch (e) {
      repoError = (e as Error).message;
    } finally {
      repoBusy = false;
    }
  }

  /** Same rule as the search list: what is attached is not on offer. */
  $: repoRows = repoSkills.filter((e) => !attached.includes(e.slug));

  // ── Costs ─────────────────────────────────────────────────────────
  /** Fixed, paid on every run: the index block the executor injects. */
  $: indexCost = attached.length
    ? SKILL_INDEX_PREAMBLE_TOKENS +
      attached.reduce((sum, slug) => {
        const item = bySlug.get(slug);
        // Only a live status is actually written into the index — an
        // orphan, a disabled row, or an errored one all contribute nothing,
        // because the resolver's own WHERE clause drops them before the
        // index is built.
        return item && isLive(item) ? sum + skillIndexTokens(slug, skillDescription(item)) : sum;
      }, 0)
    : 0;

  /**
   * `indexCost` is only meaningful once the wider inventory fetch has
   * actually resolved statuses — before that (or after a failed fetch)
   * every slug reads as "not live" and the number silently drops to
   * whatever the preamble alone costs. A confidently wrong small number is
   * worse than no number, so the pill renders "—" instead.
   */
  $: costUnknown = !inventoryLoaded || !!inventoryError;

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
          class:sk-toll-hot={!costUnknown && indexCost >= 400}
          title={costUnknown
            ? 'The installed-skill inventory has not loaded yet (or failed to), so which attached slugs are actually live is unknown — the figure cannot be computed truthfully.'
            : 'What these skills cost on EVERY run. The executor writes one index line per attached skill into the system prompt whether the skill is used or not. The body is only read when the model calls kernel_skill_load — that is the per-row figure.'}
        >
          {costUnknown ? '— tok / run (unknown)' : indexCost ? `~${fmtTok(indexCost)} tok / run` : 'no per-run cost'}
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
            {@const isSkipped = skippedSlugs.includes(slug)}
            {@const isInactive = inactiveSlugs.includes(slug)}
            <li
              class="sk-row"
              class:sk-row-orphan={isOrphan || isSkipped}
              class:sk-row-warn={isInactive}
            >
              <span class="sk-glyph" aria-hidden="true"
                >{isOrphan ? '⚠' : isSkipped ? '⊘' : isInactive ? '◐' : '▸'}</span
              >
              <span class="sk-main">
                <span class="sk-slug">{slug}</span>
                {#if isOrphan}
                  <span class="sk-note sk-note-bad">{$t('agent.skills.not_installed')}</span>
                {:else if isSkipped}
                  <span class="sk-note sk-note-bad"
                    >installed but {item?.status ?? 'skipped'} — every run skips it</span
                  >
                {:else if isInactive}
                  <span class="sk-note sk-note-warn">{$t('agent.skills.installed_inactive')}</span>
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
                title={$t('agent.skills.detach_title')}
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
        {#if skippedSlugs.length}
          <p class="sk-warn">
            {skippedSlugs.length} attached slug{skippedSlugs.length === 1 ? '' : 's'} ({skippedSlugs.join(
              ', '
            )}) {skippedSlugs.length === 1 ? 'is' : 'are'} installed but disabled or errored. The
            executor skips {skippedSlugs.length === 1 ? 'it' : 'them'} on every run just like an
            uninstalled skill — detach, or fix {skippedSlugs.length === 1 ? 'it' : 'them'} from
            <a href="/extensions?tab=skills">Extensions → Skills</a>.
          </p>
        {/if}
      {/if}

      {#if inventoryError}
        <p class="sk-err">
          Could not read the installed skills ({inventoryError}) — the marks above cannot be
          trusted until this loads, and the per-run cost pill above is unknown, not zero.
        </p>
      {/if}
    </section>

    <!-- ═══ RECOMMENDED ═══ -->
    <section class="sk-zone">
      <header class="sk-zh">
        <h3 class="sk-h">{$t('agent.skills.recommended')}</h3>
        <span
          class="sk-hint"
          title={$t('agent.skills.ranked_hint_title')}
        >
          {$t('agent.skills.ranked_hint')}
        </span>
      </header>

      {#if sugUnsupported}
        <p class="sk-empty">
          {$t('agent.skills.no_route_before')} <code>/api/agents/:id/skill-suggestions</code> {$t('agent.skills.no_route_after')}
        </p>
      {:else if sugLoading}
        <p class="sk-empty">{$t('agent.skills.scoring')}</p>
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
              <span class="sk-score" title={$t('agent.skills.score_title')}
                >{s.score.toFixed(1)}</span
              >
              <span class="sk-main">
                <span class="sk-slug">
                  {s.slug}
                  {#if !s.installed}<span class="sk-tag">{$t('agent.skills.catalogue_word')}</span>{/if}
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
                  title={$t('agent.skills.attach_title')}
                  on:click={() => attach(s.slug)}
                  disabled={!!busy[s.slug]}>{busy[s.slug] ? '…' : '+'}</button
                >
              {:else}
                <button
                  class="sk-add sk-add-dl"
                  title={$t('agent.skills.install_attach_title')}
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
          {$t('agent.skills.empty_before')} <em>{$t('agent.skills.catalogue_word')}</em>
          {$t('agent.skills.empty_mid')}
          <a href="/extensions?tab=skills">Extensions → Skills</a>.
        </p>
      {/if}
    </section>

    <!-- ═══ SEARCH ═══ -->
    <section class="sk-zone">
      <header class="sk-zh">
        <h3 class="sk-h">{$t('agent.skills.search_heading')}</h3>
        {#if searching}<span class="sk-hint">{$t('agent.skills.searching')}</span>{/if}
      </header>

      <input
        class="sk-search"
        type="text"
        bind:value={search}
        on:input={onSearchInput}
        placeholder={$t('agent.skills.search_placeholder')}
      />

      <!-- The search above is bounded by what is already subscribed; this is
           how that boundary gets moved without leaving the agent. -->
      <button
        class="sk-more"
        type="button"
        aria-expanded={showAddRepo}
        on:click={() => (showAddRepo = !showAddRepo)}
      >
        {showAddRepo ? '⊖' : '⊕'}
        {$t('agent.skills.repo_toggle')}
      </button>

      {#if showAddRepo}
        <form class="sk-repo-form" on:submit|preventDefault={addRepo}>
          <input
            class="sk-search"
            type="url"
            bind:value={repoUrl}
            disabled={repoBusy}
            placeholder={$t('agent.skills.repo_url_placeholder')}
          />
          <div class="sk-repo-line">
            <input
              class="sk-search sk-repo-ref"
              type="text"
              bind:value={repoRef}
              disabled={repoBusy}
              placeholder={$t('agent.skills.repo_ref_placeholder')}
            />
            <button
              class="sk-add sk-add-dl sk-repo-go"
              type="submit"
              disabled={repoBusy || !repoUrl.trim()}
            >
              {repoBusy ? $t('agent.skills.repo_cloning') : $t('agent.skills.repo_submit')}
            </button>
          </div>
          <p class="sk-empty">{$t('agent.skills.repo_caution')}</p>
        </form>
      {/if}

      {#if repoError}
        <p class="sk-err">{$t('agent.skills.repo_failed')} {repoError}</p>
      {/if}
      {#if repoNotice}
        <p class="sk-warn" class:sk-note={repoNoticeKind === 'info'}>{repoNotice}</p>
      {/if}

      {#if repoSkills.length}
        <header class="sk-zh sk-repo-head">
          <h3 class="sk-h">
            {$t('agent.skills.repo_from')}
            {repoLabel}
            <span class="sk-c">{repoSkills.length}</span>
          </h3>
        </header>
        {#if repoRows.length === 0}
          <p class="sk-empty">{$t('agent.skills.repo_all_attached')}</p>
        {:else}
          <ul class="sk-list">
            {#each repoRows as e (e.id)}
              {@const isInstalled = bySlug.has(e.slug)}
              <li class="sk-row">
                <span class="sk-glyph" aria-hidden="true">{isInstalled ? '▸' : '⬇'}</span>
                <span class="sk-main">
                  <span class="sk-slug">{e.slug}</span>
                  {#if e.manifest?.description}
                    <span class="sk-desc">{e.manifest.description}</span>
                  {/if}
                </span>
                {#if isInstalled}
                  <span class="sk-cost">~{fmtTok(bodyCost(e.slug))} if loaded</span>
                  <button
                    class="sk-add"
                    title={$t('agent.skills.attach_title')}
                    on:click={() => attach(e.slug)}
                    disabled={!!busy[e.slug]}>{busy[e.slug] ? '…' : '+'}</button
                  >
                {:else}
                  <button
                    class="sk-add sk-add-dl"
                    title={$t('agent.skills.install_attach_title')}
                    on:click={() => installAndAttach(e.slug, e.id)}
                    disabled={!!busy[e.slug]}
                    >{busy[e.slug] === 'installing'
                      ? '… installing'
                      : busy[e.slug]
                        ? '…'
                        : '↓+'}</button
                  >
                {/if}
              </li>
              {#if rowError[e.slug]}
                <li class="sk-rowerr">{rowError[e.slug]}</li>
              {/if}
            {/each}
          </ul>
        {/if}
      {/if}

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
                  {#if paid}<span class="sk-tag sk-tag-paid">{$t('agent.skills.paid')}</span>{/if}
                </span>
                {#if e.manifest?.description}
                  <span class="sk-desc">{e.manifest.description}</span>
                {/if}
              </span>
              {#if paid}
                <a class="sk-buy" href="/extensions?tab=skills">{$t('agent.skills.get_it')}</a>
              {:else if isInstalled}
                <span class="sk-cost">~{fmtTok(bodyCost(e.slug))} if loaded</span>
                <button
                  class="sk-add"
                  title={$t('agent.skills.attach_title')}
                  on:click={() => attach(e.slug)}
                  disabled={!!busy[e.slug]}>{busy[e.slug] ? '…' : '+'}</button
                >
              {:else}
                <button
                  class="sk-add sk-add-dl"
                  title={$t('agent.skills.install_attach_title')}
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

  /* Inline rather than a modal on purpose: this tab is mounted in the 3D
     drawer, and a dialog layered over that canvas fights the pointer. */
  .sk-repo-form {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sk-repo-line {
    display: flex;
    gap: 6px;
  }
  .sk-repo-ref {
    flex: 1;
    min-width: 0;
  }
  .sk-repo-go {
    flex: none;
    width: auto;
    padding: 0 10px;
    white-space: nowrap;
  }
  .sk-repo-head {
    margin-top: 4px;
  }
  /* Same shape as .sk-warn, repainted: nothing went wrong here. Written as a
     two-class selector because .sk-warn is declared further down — at equal
     specificity it would win on source order and the notice would stay red. */
  .sk-warn.sk-note {
    border-color: rgba(120, 170, 255, 0.28);
    background: rgba(120, 170, 255, 0.07);
    color: #9fb4e8;
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
  .sk-warn a {
    color: inherit;
    text-decoration: underline;
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

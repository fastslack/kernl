<script lang="ts">
  // /rss-reader — migrated from services/dashboard/src/routes/rss-reader/+page.svelte
  // (Fase 3). rssReader / rssRegistry stores stay shell-owned (ctx.getStore);
  // RPC keeps rpcOrCall semantics via ctx.rpc; HTTP goes through ctx.fetchRaw.
  import { onMount, onDestroy, tick } from 'svelte';
  import { sanitizeHtml } from '$shared/sanitize';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const rssReader = ctx.getStore('rssReader') as any;
  const rssRegistry = ctx.getStore('rssRegistry') as any;
  const rpcOrCall = (action: string, params: Record<string, unknown>, fallback: () => Promise<any>) =>
    ctx.rpc(action, params, fallback);

  // ── Types ────────────────────────────────────────────────
  interface ReaderItem {
    id: string;
    feed_id: string;
    title: string;
    link: string;
    author: string;
    description: string;
    content: string;
    image_url: string;
    published_at: string | null;
    fetched_at: string;
    feed_name: string;
    feed_slug: string;
    feed_url: string;
    category_id: string | null;
    category_name: string | null;
    category_icon: string | null;
    language: string;
    read: number;
    starred: number;
    read_at: string | null;
  }
  interface FeedRow {
    id: string; name: string; slug: string; category_id: string | null;
    category_name?: string | null; category_icon?: string | null;
    feed_url: string; status: string; quality_score: number; language: string;
  }
  interface CategoryRow { id: string; name: string; icon: string; parent_id?: string | null; sort_order?: number; }

  // ── State ────────────────────────────────────────────────
  let items: ReaderItem[] = [];
  let stats = { total_items: 0, unread: 0, starred: 0, unread_today: 0,
                unread_by_feed: {} as Record<string, number>,
                unread_by_category: {} as Record<string, number> };
  let feeds: FeedRow[] = [];
  let categories: CategoryRow[] = [];
  let selectedItem: ReaderItem | null = null;
  let activeFilter: 'all' | 'unread' | 'starred' | 'today' = 'unread';
  let activeFeedId = '';
  let activeCategoryId = '';
  let search = '';
  // All categories start collapsed — we usually have many. Keep an
  // "expanded" set instead, which defaults empty (= everything collapsed).
  let expandedCats = new Set<string>();
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Folder editing state ──
  // Inline rename: editingCatId holds the id of the row currently in edit mode.
  // editingCatName mirrors the input. Save → commitEditCat. Cancel → cancelEditCat.
  let editingCatId: string | null = null;
  let editingCatName = '';
  let creatingCat = false;
  let newCatName = '';
  // Drag-and-drop:
  //   - dragFeedId  = a feed is being dragged (for cat→cat move OR same-cat reorder).
  //   - dragCatId   = a category row is being dragged (to reorder folders).
  //   - dropCatId   = which category is currently the drop target (for cat→cat moves).
  //   - dropFeedId / dropFeedSide = which feed is the reorder target, and on which side.
  //   - dropCatPos  = where between two categories the reorder marker is shown.
  let dragFeedId: string | null = null;
  let dragCatId: string | null = null;
  let dropCatId: string | null = null;
  let dropFeedId: string | null = null;
  let dropFeedSide: 'before' | 'after' | null = null;
  let dropCatPos: { id: string; side: 'before' | 'after' } | null = null;
  // Inline "move feed to folder" popover. When set, a small list of folders
  // is rendered next to the feed; clicking one moves the feed there.
  let moveMenuFeedId: string | null = null;
  let refreshing = false;
  let loading = true;
  let lastRefresh: number | null = null;

  // ── Derived ──────────────────────────────────────────────
  $: feedsByCategory = (() => {
    const m = new Map<string, FeedRow[]>();
    for (const f of feeds) {
      const k = f.category_id ?? '__uncat__';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(f);
    }
    return m;
  })();

  // Build the parent → children index for the tree. `null` parent = root.
  $: catChildren = (() => {
    const m = new Map<string | null, CategoryRow[]>();
    for (const c of categories) {
      const k = c.parent_id ?? null;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(c);
    }
    return m;
  })();
  $: rootCats = catChildren.get(null) ?? [];

  /**
   * Strip the "Parent/" prefix from a child category's display name. The
   * tree's indentation already shows the relationship, so duplicating it in
   * the label would just be noise. Roots and the virtual __uncat__ pass
   * through unchanged.
   */
  function displayCatName(cat: CategoryRow): string {
    if (cat.parent_id) {
      const slash = cat.name.indexOf('/');
      if (slash !== -1) return cat.name.slice(slash + 1);
    }
    return cat.name;
  }

  /**
   * Sum of unread items in this category AND all of its descendants. Mirrors
   * what the server-side subtree filter returns when the user clicks a
   * parent — keeps the badge consistent with the inbox count.
   */
  function rolledUpUnread(catId: string): number {
    let n = catId === '__uncat__' ? (stats.unread_by_category[''] ?? 0) : (stats.unread_by_category[catId] ?? 0);
    const kids = catChildren.get(catId) ?? [];
    for (const k of kids) n += rolledUpUnread(k.id);
    return n;
  }

  /**
   * Total feed count in subtree (including descendants). Used to decide
   * whether a parent row is "clickable for filter" or just an organisational
   * grouper. With this, a parent like Entertainment that has no direct feeds
   * but whose children carry many is still treated as clickable.
   */
  function subtreeFeedCount(catId: string): number {
    let n = (feedsByCategory.get(catId) ?? []).length;
    const kids = catChildren.get(catId) ?? [];
    for (const k of kids) n += subtreeFeedCount(k.id);
    return n;
  }

  /**
   * Categories arranged for the "move to folder" popover: each root is
   * followed immediately by its children. Without this the children would
   * scatter alphabetically and the hierarchy would be invisible in the
   * picker.
   */
  $: categoriesForMove = (() => {
    const out: CategoryRow[] = [];
    for (const root of rootCats) {
      out.push(root);
      const kids = catChildren.get(root.id) ?? [];
      for (const k of kids) out.push(k);
    }
    return out;
  })();

  // Items shown in the list. The server already filters by feed/category/
  // status/search via /api/reader/rss/items — see loadItems() below — so the
  // client side just renders whatever we got back.
  $: filteredItems = items;

  // ── Helpers ──────────────────────────────────────────────
  function timeAgo(iso: string | null): string {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 604800) return `${Math.floor(s / 86400)}d`;
    return new Date(iso).toLocaleDateString();
  }

  // RSS content comes from arbitrary remote feeds — must be DOMPurify-grade.
  // (Old regex blacklist was bypassable with `<svg onload=...>`, encoded URIs,
  // and anything not literally listed. Now delegates to $lib/sanitize.)
  const safeHtml = sanitizeHtml;

  function categoryColorFor(name: string): string {
    const palette = ['var(--gold)', 'var(--teal)', 'var(--purple)', 'var(--blue)', 'var(--green)', 'var(--orange)'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
  }

  // ── Data ─────────────────────────────────────────────────
  /**
   * One-time bootstrap: fetches stats, the feed catalog, and the categories.
   * Items are NOT loaded here — the reactive `$: loadItems()` block fires on
   * mount (and on every filter change) and pulls the right slice from the
   * server.
   */
  async function bootstrap() {
    try {
      const [readerData, registryData] = await Promise.all([
        ctx.fetchRaw('/api/reader/rss/bootstrap').then(r => r.json()).catch(() => null),
        ctx.fetchRaw('/api/registry/rss').then(r => r.json()).catch(() => null),
      ]);
      if (readerData) {
        stats = readerData.stats ?? stats;
        rssReader.set(readerData);
      }
      if (registryData) {
        feeds = registryData.feeds ?? [];
        categories = registryData.categories ?? [];
        rssRegistry.set(registryData);
      }
    } catch {/* swallow — loadItems will retry */}
  }

  /**
   * Pulls items from the server with the current filters applied. Called on
   * mount, on every filter change (via reactive block at the bottom of the
   * script), and after refresh / mark-all-read mutations.
   */
  let loadItemsToken = 0; // cancellation token: ignore stale responses
  async function loadItems() {
    const token = ++loadItemsToken;
    loading = true;
    try {
      const params = new URLSearchParams();
      if (activeFeedId)     params.set('feed_id', activeFeedId);
      if (activeCategoryId) params.set('category_id', activeCategoryId);
      if (activeFilter === 'unread')  params.set('unread_only', '1');
      if (activeFilter === 'starred') params.set('starred_only', '1');
      if (activeFilter === 'today') {
        const t = new Date(); t.setHours(0, 0, 0, 0);
        params.set('since', t.toISOString());
      }
      if (search.trim()) params.set('q', search.trim());
      params.set('limit', '300');
      const r = await ctx.fetchRaw('/api/reader/rss/items?' + params.toString());
      const data = await r.json();
      // Drop the response if a newer request started while we were waiting.
      if (token !== loadItemsToken) return;
      items = data.items ?? [];
    } catch (err) {
      if (token === loadItemsToken) items = [];
    } finally {
      if (token === loadItemsToken) loading = false;
    }
  }

  // Refetch stats so the badges in the sidebar / chips stay in sync after
  // a mutation. Cheap: just hits the bootstrap endpoint for stats.
  async function refreshStats() {
    try {
      const r = await ctx.fetchRaw('/api/reader/rss/bootstrap');
      const d = await r.json();
      if (d?.stats) stats = d.stats;
    } catch {/* noop */}
  }

  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    try {
      await rpcOrCall('registry.rss.refresh', {}, async () => {
        const r = await ctx.fetchRaw('/api/registry/rss/refresh', { method: 'POST' });
        return r.json();
      });
      lastRefresh = Date.now();
      await bootstrap();
      await loadItems();
    } catch (err) {
      alert('Refresh failed: ' + (err instanceof Error ? err.message : err));
    } finally {
      refreshing = false;
    }
  }

  async function refreshSingle(feedId: string) {
    try {
      await ctx.fetchRaw(`/api/registry/rss/${feedId}/refresh`, { method: 'POST' });
      await refreshStats();
      await loadItems();
    } catch (err) {
      console.warn('Single refresh failed', err);
    }
  }

  async function selectItem(item: ReaderItem) {
    selectedItem = item;
    if (!item.read) {
      // Optimistic: flip locally first, then sync.
      item.read = 1;
      items = items;
      stats = { ...stats, unread: Math.max(0, stats.unread - 1) };
      try {
        await ctx.fetchRaw(`/api/reader/rss/items/${item.id}/read`, { method: 'POST' });
      } catch {/* swallow — visual already reflects intent */}
    }
    // Lazy-load full content if it's not in the list payload
    if (!item.content || item.content.length < 200) {
      try {
        const r = await ctx.fetchRaw(`/api/reader/rss/items/${item.id}`);
        const data = await r.json();
        if (data.item) {
          selectedItem = { ...selectedItem!, ...data.item };
        }
      } catch {/* keep description */}
    }
  }

  async function toggleStar(item: ReaderItem) {
    item.starred = item.starred ? 0 : 1;
    items = items;
    if (selectedItem?.id === item.id) selectedItem = { ...item };
    try {
      await ctx.fetchRaw(`/api/reader/rss/items/${item.id}/star`, { method: 'POST' });
    } catch {/* noop */}
  }

  async function toggleRead(item: ReaderItem) {
    const willBeRead = !item.read;
    item.read = willBeRead ? 1 : 0;
    stats = { ...stats, unread: stats.unread + (willBeRead ? -1 : +1) };
    items = items;
    if (selectedItem?.id === item.id) selectedItem = { ...item };
    try {
      await ctx.fetchRaw(`/api/reader/rss/items/${item.id}/${willBeRead ? 'read' : 'unread'}`, { method: 'POST' });
    } catch {/* noop */}
  }

  async function markAllRead() {
    if (!confirm('Mark all visible items as read?')) return;
    try {
      await ctx.fetchRaw('/api/reader/rss/markAllRead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feed_id: activeFeedId || undefined,
          category_id: activeCategoryId || undefined,
        }),
      });
      await refreshStats();
      await loadItems();
    } catch {/* noop */}
  }

  function selectFeed(id: string) {
    activeFeedId = id;
    activeCategoryId = '';
    selectedItem = null;
    loadItems();
  }
  function clearSelection() {
    activeFeedId = '';
    activeCategoryId = '';
    selectedItem = null;
    loadItems();
  }
  // One click on a category row: toggle expand AND filter to it.
  // Click again on the same already-expanded one: collapse + clear filter.
  function clickCategory(id: string) {
    const isExpanded = expandedCats.has(id);
    if (isExpanded && activeCategoryId === id) {
      expandedCats.delete(id);
      activeCategoryId = '';
    } else {
      expandedCats.add(id);
      activeCategoryId = id;
      activeFeedId = '';
    }
    expandedCats = new Set(expandedCats);
    selectedItem = null;
    loadItems();
  }
  function setFilter(f: typeof activeFilter) {
    activeFilter = f;
    selectedItem = null;
    loadItems();
  }
  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadItems(), 300);
  }

  // ── Inline folder editing ──
  /** Svelte action: focus an input as soon as it mounts. */
  function focusOnMount(node: HTMLInputElement) {
    setTimeout(() => { node.focus(); node.select(); }, 0);
    return {};
  }

  function startEditCat(cat: { id: string; name: string }) {
    if (cat.id === '__uncat__') return; // virtual category, can't rename
    editingCatId = cat.id;
    editingCatName = cat.name;
  }
  function cancelEditCat() {
    editingCatId = null;
    editingCatName = '';
  }
  async function commitEditCat() {
    const id = editingCatId;
    const name = editingCatName.trim();
    if (!id || !name) { cancelEditCat(); return; }
    try {
      const r = await ctx.fetchRaw(`/api/registry/rss/categories/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Mirror change locally so the UI updates immediately, no full refetch.
      categories = categories.map(c => c.id === id ? { ...c, name } : c);
    } catch (err) {
      alert('Rename failed: ' + (err instanceof Error ? err.message : err));
    } finally {
      cancelEditCat();
    }
  }
  function onEditCatKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitEditCat(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEditCat(); }
  }

  async function commitNewCat() {
    const name = newCatName.trim();
    if (!name) { creatingCat = false; newCatName = ''; return; }
    try {
      const r = await ctx.fetchRaw('/api/registry/rss/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data.category) {
        categories = [...categories, data.category];
      }
    } catch (err) {
      alert('Create failed: ' + (err instanceof Error ? err.message : err));
    } finally {
      creatingCat = false;
      newCatName = '';
    }
  }
  function onNewCatKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitNewCat(); }
    else if (e.key === 'Escape') { e.preventDefault(); creatingCat = false; newCatName = ''; }
  }

  async function deleteCategoryConfirm(cat: { id: string; name: string }) {
    const feedsInside = feeds.filter(f => f.category_id === cat.id).length;
    const msg = feedsInside > 0
      ? `Delete folder "${cat.name}"? The ${feedsInside} feed${feedsInside !== 1 ? 's' : ''} inside will move to Uncategorized.`
      : `Delete empty folder "${cat.name}"?`;
    if (!confirm(msg)) return;
    try {
      const r = await ctx.fetchRaw(`/api/registry/rss/categories/${cat.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Local mirror: drop the category, orphan its feeds.
      categories = categories.filter(c => c.id !== cat.id);
      feeds = feeds.map(f => f.category_id === cat.id ? { ...f, category_id: null } : f);
    } catch (err) {
      alert('Delete failed: ' + (err instanceof Error ? err.message : err));
    }
  }

  // ── Drag and drop: move/reorder feeds and categories ──
  /**
   * Persist the current order of feeds inside `catId` to the server. We send
   * the full list (server rewrites sort_order 0..N-1 in one transaction).
   * `catId === '__uncat__'` is normalised to `null` for the API.
   */
  async function persistFeedOrder(catId: string) {
    const ids = feeds.filter(f => (f.category_id ?? '__uncat__') === catId).map(f => f.id);
    if (ids.length === 0) return;
    try {
      await ctx.fetchRaw('/api/registry/rss/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category_id: catId === '__uncat__' ? null : catId, ids }),
      });
    } catch (err) {
      console.warn('persistFeedOrder failed', err);
    }
  }

  /** Persist the current category ordering. */
  async function persistCatOrder() {
    const ids = categories.map(c => c.id);
    if (ids.length === 0) return;
    try {
      await ctx.fetchRaw('/api/registry/rss/categories/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    } catch (err) {
      console.warn('persistCatOrder failed', err);
    }
  }

  function onFeedDragStart(e: DragEvent, feed: FeedRow) {
    dragFeedId = feed.id;
    dragCatId = null;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', feed.id);
    }
  }
  /** Hovering over another feed: show a before/after marker for in-place reorder. */
  function onFeedDragOver(e: DragEvent, feed: FeedRow) {
    if (!dragFeedId || dragFeedId === feed.id) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    dropFeedId = feed.id;
    dropFeedSide = after ? 'after' : 'before';
    dropCatId = null;
  }
  function onFeedDragLeave() { /* let drop or category-over clear it */ }

  /** Drop on a feed: reorder relative to it, possibly across categories. */
  async function onFeedDrop(e: DragEvent, target: FeedRow) {
    e.preventDefault();
    e.stopPropagation();
    const feedId = dragFeedId;
    const side = dropFeedSide ?? 'after';
    dragFeedId = null;
    dropFeedId = null;
    dropFeedSide = null;
    dropCatId = null;
    if (!feedId || feedId === target.id) return;

    const src = feeds.find(f => f.id === feedId);
    if (!src) return;
    const targetCat = target.category_id ?? '__uncat__';

    // Build the new feeds array: pull `src` out, then re-insert it next to `target`.
    const without = feeds.filter(f => f.id !== feedId);
    const targetIdx = without.findIndex(f => f.id === target.id);
    if (targetIdx === -1) return;
    const insertAt = side === 'before' ? targetIdx : targetIdx + 1;
    const newSrc = { ...src, category_id: targetCat === '__uncat__' ? null : targetCat };
    const reordered = [...without.slice(0, insertAt), newSrc, ...without.slice(insertAt)];
    feeds = reordered;

    // Persist the affected categories. If we crossed folders, both need
    // their sort_order rewritten so neither one ends up with gaps.
    const movedCrossCat = (src.category_id ?? '__uncat__') !== targetCat;
    await persistFeedOrder(targetCat);
    if (movedCrossCat) await persistFeedOrder(src.category_id ?? '__uncat__');
  }

  function onCatDragOver(e: DragEvent, catId: string) {
    // A feed dragged onto a category row appends it to that category.
    if (dragFeedId) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      dropCatId = catId;
      dropFeedId = null;
      dropFeedSide = null;
      return;
    }
    // A category dragged onto another category: reorder folders.
    if (dragCatId && dragCatId !== catId && catId !== '__uncat__') {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      dropCatPos = { id: catId, side: after ? 'after' : 'before' };
    }
  }
  function onCatDragLeave() { /* no-op — drop will clear */ }

  async function onCatDrop(e: DragEvent, catId: string) {
    e.preventDefault();

    // ── Case 1: dropping a feed onto a folder → move (append) feed there.
    if (dragFeedId) {
      const feedId = dragFeedId;
      dragFeedId = null;
      dropCatId = null;
      const feed = feeds.find(f => f.id === feedId);
      if (!feed) return;
      if ((feed.category_id ?? '__uncat__') === catId) return;
      // Move feed to the end of the target category, locally.
      const others = feeds.filter(f => f.id !== feedId);
      const updated = { ...feed, category_id: catId === '__uncat__' ? null : catId };
      // Place it right after the last feed already in `catId`, so it lands at
      // the bottom of that folder visually.
      const lastIdxInCat = (() => {
        let last = -1;
        for (let i = 0; i < others.length; i++) {
          if ((others[i].category_id ?? '__uncat__') === catId) last = i;
        }
        return last;
      })();
      const insertAt = lastIdxInCat + 1;
      feeds = [...others.slice(0, insertAt), updated, ...others.slice(insertAt)];
      await persistFeedOrder(catId);
      if ((feed.category_id ?? '__uncat__') !== catId) {
        await persistFeedOrder(feed.category_id ?? '__uncat__');
      }
      return;
    }

    // ── Case 2: dropping a category onto another category → reorder folders.
    if (dragCatId && dragCatId !== catId && catId !== '__uncat__') {
      const fromId = dragCatId;
      const side = dropCatPos?.side ?? 'after';
      dragCatId = null;
      dropCatPos = null;
      const fromIdx = categories.findIndex(c => c.id === fromId);
      const toIdx = categories.findIndex(c => c.id === catId);
      if (fromIdx === -1 || toIdx === -1) return;
      const moved = categories[fromIdx];
      const without = categories.filter(c => c.id !== fromId);
      const targetIdxAfterRemoval = without.findIndex(c => c.id === catId);
      const insertAt = side === 'before' ? targetIdxAfterRemoval : targetIdxAfterRemoval + 1;
      categories = [...without.slice(0, insertAt), moved, ...without.slice(insertAt)];
      await persistCatOrder();
      return;
    }
    dragCatId = null;
    dropCatPos = null;
  }

  /** Begin dragging a category row. */
  function onCatDragStart(e: DragEvent, cat: { id: string; name: string }) {
    if (cat.id === '__uncat__') { e.preventDefault(); return; }
    dragCatId = cat.id;
    dragFeedId = null;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `cat:${cat.id}`);
    }
  }
  function onSidebarDragEnd() {
    dragFeedId = null;
    dragCatId = null;
    dropCatId = null;
    dropFeedId = null;
    dropFeedSide = null;
    dropCatPos = null;
  }

  /** Click ⇲ on a feed → open inline popover; click outside → close. */
  function toggleMoveMenu(feedId: string) {
    moveMenuFeedId = moveMenuFeedId === feedId ? null : feedId;
  }
  /** Pick a category from the popover: move feed there (and close). */
  async function moveFeedTo(feedId: string, catId: string) {
    moveMenuFeedId = null;
    const feed = feeds.find(f => f.id === feedId);
    if (!feed) return;
    const currentCat = feed.category_id ?? '__uncat__';
    if (currentCat === catId) return;
    // Local mirror first so the UI reflects intent immediately.
    const others = feeds.filter(f => f.id !== feedId);
    const updated = { ...feed, category_id: catId === '__uncat__' ? null : catId };
    let lastIdxInCat = -1;
    for (let i = 0; i < others.length; i++) {
      if ((others[i].category_id ?? '__uncat__') === catId) lastIdxInCat = i;
    }
    const insertAt = lastIdxInCat + 1;
    feeds = [...others.slice(0, insertAt), updated, ...others.slice(insertAt)];
    await persistFeedOrder(catId);
    await persistFeedOrder(currentCat);
  }
  /** Close the move-menu when clicking anywhere else. */
  function closeMoveMenuOnDocClick(e: MouseEvent) {
    if (!moveMenuFeedId) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest && t.closest('.rr-move-pop, .rr-move-trigger')) return;
    moveMenuFeedId = null;
  }

  // ── Keyboard navigation (j/k = next/prev unread) ─────────
  async function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      const list = filteredItems;
      if (list.length === 0) return;
      const cur = selectedItem ? list.findIndex(i => i.id === selectedItem!.id) : -1;
      let next = cur + (e.key === 'j' ? 1 : -1);
      if (next < 0) next = 0;
      if (next >= list.length) next = list.length - 1;
      await selectItem(list[next]);
      await tick();
      document.querySelector('.item.active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (e.key === 'r' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      refreshAll();
    }
    if (e.key === 'Escape' && selectedItem) {
      selectedItem = null;
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  onMount(async () => {
    await bootstrap();
    await loadItems();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', closeMoveMenuOnDocClick);
    // Light background poll so the badges/list stay fresh while user reads.
    pollTimer = setInterval(async () => {
      await refreshStats();
      await loadItems();
    }, 90_000);
  });
  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', closeMoveMenuOnDocClick);
    }
    if (pollTimer) clearInterval(pollTimer);
    if (searchTimer) clearTimeout(searchTimer);
  });
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
</svelte:head>

<div class="rr" class:reading={!!selectedItem}>
  <!-- ═══════════════════ Sidebar: Sources ═══════════════════ -->
  <aside class="rr-sb">
    <div class="rr-sb-body">
      {#if activeFeedId || activeCategoryId}
        <button class="rr-back" on:click={clearSelection}>
          <span class="rr-back-arrow">←</span>
          <span>Show all</span>
        </button>
      {/if}

      <!--
        Tree: root categories first (parent_id == null), each one with its
        direct feeds AND its child folders nested inside. Children render the
        same row + feed-list pattern, indented one level. We never go deeper
        than two levels because that's all the data has — but the markup is
        symmetric, so adding deeper levels would be a small change.
        Uncategorized is appended as a virtual root row.
      -->
      {#each [...rootCats, { id: '__uncat__', name: 'Uncategorized', icon: '', parent_id: null }] as cat (cat.id)}
        {@const catFeeds = feedsByCategory.get(cat.id) ?? []}
        {@const kids = catChildren.get(cat.id) ?? []}
        {@const totalFeeds = subtreeFeedCount(cat.id)}
        {@const catUnread = rolledUpUnread(cat.id)}
        {@const expanded = expandedCats.has(cat.id)}
        {@const accent = categoryColorFor(cat.name)}
        {@const isEditing = editingCatId === cat.id}
        {@const hasChildren = kids.length > 0}
        {#if totalFeeds > 0 || isEditing}
          <div class="rr-cat"
               class:drop={dropCatId === cat.id}
               class:dragging={dragCatId === cat.id}
               class:drop-cat-before={dropCatPos?.id === cat.id && dropCatPos?.side === 'before'}
               class:drop-cat-after={dropCatPos?.id === cat.id && dropCatPos?.side === 'after'}
               style="--accent: {accent}"
               on:dragover={(e) => onCatDragOver(e, cat.id)}
               on:dragleave={onCatDragLeave}
               on:drop={(e) => onCatDrop(e, cat.id)}
               on:dragend={onSidebarDragEnd}
               role="region">
            <div class="rr-cat-row"
                 class:active={activeCategoryId === cat.id}
                 class:has-children={hasChildren}
                 draggable={cat.id !== '__uncat__' && !isEditing}
                 on:dragstart={(e) => onCatDragStart(e, cat)}>
              {#if cat.id !== '__uncat__' && !isEditing}
                <span class="rr-cat-grip" title="Drag to reorder folder">⋮⋮</span>
              {/if}
              <button class="rr-cat-main" on:click={() => clickCategory(cat.id)} on:dblclick={() => startEditCat(cat)}>
                <span class="rr-cat-icon">
                  {#if cat.icon}{cat.icon}{:else}<span class="rr-cat-dot"></span>{/if}
                </span>
                {#if isEditing}
                  <input class="rr-cat-input"
                         bind:value={editingCatName}
                         on:keydown={onEditCatKey}
                         on:click|stopPropagation
                         use:focusOnMount />
                {:else}
                  <span class="rr-cat-name">{displayCatName(cat)}</span>
                  {#if hasChildren}<span class="rr-cat-kidnum" title="{kids.length} sub-folder{kids.length === 1 ? '' : 's'}">{kids.length}</span>{/if}
                {/if}
                {#if catUnread > 0 && !isEditing}<span class="rr-cat-num">{catUnread}</span>{/if}
                {#if !isEditing}<span class="rr-cat-chev" class:open={expanded}>›</span>{/if}
              </button>

              {#if isEditing}
                <button class="rr-cat-action ok" title="Save" on:click|stopPropagation={commitEditCat}>✓</button>
                <button class="rr-cat-action" title="Cancel" on:click|stopPropagation={cancelEditCat}>✕</button>
              {:else if cat.id !== '__uncat__'}
                <button class="rr-cat-action ghost"
                        title="Rename"
                        on:click|stopPropagation={() => startEditCat(cat)}>✎</button>
                <button class="rr-cat-action ghost danger"
                        title="Delete folder"
                        on:click|stopPropagation={() => deleteCategoryConfirm(cat)}>×</button>
              {/if}
            </div>

            {#if expanded && !isEditing}
              <!-- Direct feeds in this root category (if any). -->
              {#if catFeeds.length > 0}
                <ul class="rr-feeds">
                  {#each catFeeds as feed (feed.id)}
                    {@const unread = stats.unread_by_feed[feed.id] ?? 0}
                    {@const isMoveOpen = moveMenuFeedId === feed.id}
                    <li class="rr-feed-row"
                        class:drop-before={dropFeedId === feed.id && dropFeedSide === 'before'}
                        class:drop-after={dropFeedId === feed.id && dropFeedSide === 'after'}>
                      <button class="rr-feed" class:active={activeFeedId === feed.id}
                              class:has-unread={unread > 0}
                              class:dragging={dragFeedId === feed.id}
                              draggable="true"
                              on:dragstart={(e) => onFeedDragStart(e, feed)}
                              on:dragover={(e) => onFeedDragOver(e, feed)}
                              on:dragleave={onFeedDragLeave}
                              on:drop={(e) => onFeedDrop(e, feed)}
                              on:dragend={onSidebarDragEnd}
                              on:click|stopPropagation={() => selectFeed(feed.id)}>
                        <span class="rr-feed-tick"></span>
                        <span class="rr-feed-name">{feed.name}</span>
                        {#if unread > 0}<span class="rr-feed-num">{unread}</span>{/if}
                        <span class="rr-move-trigger"
                              class:on={isMoveOpen}
                              title="Move to folder…"
                              role="button"
                              tabindex="0"
                              on:click|stopPropagation={() => toggleMoveMenu(feed.id)}
                              on:keydown|stopPropagation={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMoveMenu(feed.id); } }}>⇲</span>
                      </button>
                      {#if isMoveOpen}
                        <div class="rr-move-pop" on:click|stopPropagation>
                          <div class="rr-move-pop-head">Move to…</div>
                          {#each categoriesForMove as moveCat (moveCat.id)}
                            {@const isChild = !!moveCat.parent_id}
                            {@const parentCat = isChild ? categories.find(c => c.id === moveCat.parent_id) : null}
                            <button class="rr-move-opt"
                                    class:child={isChild}
                                    class:current={moveCat.id === feed.category_id}
                                    on:click={() => moveFeedTo(feed.id, moveCat.id)}>
                              <span class="rr-move-opt-icon">{moveCat.icon || '•'}</span>
                              <span class="rr-move-opt-name">
                                {#if isChild && parentCat}<span class="rr-move-opt-parent">{parentCat.name} ›</span>{/if}{displayCatName(moveCat)}
                              </span>
                              {#if moveCat.id === feed.category_id}<span class="rr-move-opt-tick">✓</span>{/if}
                            </button>
                          {/each}
                          <button class="rr-move-opt"
                                  class:current={!feed.category_id}
                                  on:click={() => moveFeedTo(feed.id, '__uncat__')}>
                            <span class="rr-move-opt-icon">○</span>
                            <span class="rr-move-opt-name">Uncategorized</span>
                            {#if !feed.category_id}<span class="rr-move-opt-tick">✓</span>{/if}
                          </button>
                        </div>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}

              <!-- Child folders, rendered indented under the parent. -->
              {#if hasChildren}
                <div class="rr-subcats">
                  {#each kids as childCat (childCat.id)}
                    {@const childFeeds = feedsByCategory.get(childCat.id) ?? []}
                    {@const childUnread = rolledUpUnread(childCat.id)}
                    {@const childExpanded = expandedCats.has(childCat.id)}
                    {@const childAccent = categoryColorFor(childCat.name)}
                    {@const childEditing = editingCatId === childCat.id}
                    {#if childFeeds.length > 0 || childEditing}
                      <div class="rr-cat rr-cat-child"
                           class:drop={dropCatId === childCat.id}
                           class:dragging={dragCatId === childCat.id}
                           style="--accent: {childAccent}"
                           on:dragover={(e) => onCatDragOver(e, childCat.id)}
                           on:dragleave={onCatDragLeave}
                           on:drop={(e) => onCatDrop(e, childCat.id)}
                           on:dragend={onSidebarDragEnd}
                           role="region">
                        <div class="rr-cat-row rr-cat-row-child"
                             class:active={activeCategoryId === childCat.id}
                             draggable={!childEditing}
                             on:dragstart={(e) => onCatDragStart(e, childCat)}>
                          {#if !childEditing}
                            <span class="rr-cat-grip" title="Drag to reorder">⋮⋮</span>
                          {/if}
                          <button class="rr-cat-main" on:click={() => clickCategory(childCat.id)} on:dblclick={() => startEditCat(childCat)}>
                            <span class="rr-cat-icon rr-cat-icon-sm">
                              {#if childCat.icon}{childCat.icon}{:else}<span class="rr-cat-dot"></span>{/if}
                            </span>
                            {#if childEditing}
                              <input class="rr-cat-input"
                                     bind:value={editingCatName}
                                     on:keydown={onEditCatKey}
                                     on:click|stopPropagation
                                     use:focusOnMount />
                            {:else}
                              <span class="rr-cat-name">{displayCatName(childCat)}</span>
                            {/if}
                            {#if childUnread > 0 && !childEditing}<span class="rr-cat-num">{childUnread}</span>{/if}
                            {#if !childEditing}<span class="rr-cat-chev" class:open={childExpanded}>›</span>{/if}
                          </button>

                          {#if childEditing}
                            <button class="rr-cat-action ok" title="Save" on:click|stopPropagation={commitEditCat}>✓</button>
                            <button class="rr-cat-action" title="Cancel" on:click|stopPropagation={cancelEditCat}>✕</button>
                          {:else}
                            <button class="rr-cat-action ghost" title="Rename"
                                    on:click|stopPropagation={() => startEditCat(childCat)}>✎</button>
                            <button class="rr-cat-action ghost danger" title="Delete folder"
                                    on:click|stopPropagation={() => deleteCategoryConfirm(childCat)}>×</button>
                          {/if}
                        </div>

                        {#if childExpanded && !childEditing}
                          <ul class="rr-feeds rr-feeds-child">
                            {#each childFeeds as feed (feed.id)}
                              {@const unread = stats.unread_by_feed[feed.id] ?? 0}
                              {@const isMoveOpen = moveMenuFeedId === feed.id}
                              <li class="rr-feed-row"
                                  class:drop-before={dropFeedId === feed.id && dropFeedSide === 'before'}
                                  class:drop-after={dropFeedId === feed.id && dropFeedSide === 'after'}>
                                <button class="rr-feed rr-feed-child" class:active={activeFeedId === feed.id}
                                        class:has-unread={unread > 0}
                                        class:dragging={dragFeedId === feed.id}
                                        draggable="true"
                                        on:dragstart={(e) => onFeedDragStart(e, feed)}
                                        on:dragover={(e) => onFeedDragOver(e, feed)}
                                        on:dragleave={onFeedDragLeave}
                                        on:drop={(e) => onFeedDrop(e, feed)}
                                        on:dragend={onSidebarDragEnd}
                                        on:click|stopPropagation={() => selectFeed(feed.id)}>
                                  <span class="rr-feed-tick"></span>
                                  <span class="rr-feed-name">{feed.name}</span>
                                  {#if unread > 0}<span class="rr-feed-num">{unread}</span>{/if}
                                  <span class="rr-move-trigger"
                                        class:on={isMoveOpen}
                                        title="Move to folder…"
                                        role="button"
                                        tabindex="0"
                                        on:click|stopPropagation={() => toggleMoveMenu(feed.id)}
                                        on:keydown|stopPropagation={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMoveMenu(feed.id); } }}>⇲</span>
                                </button>
                                {#if isMoveOpen}
                                  <div class="rr-move-pop" on:click|stopPropagation>
                                    <div class="rr-move-pop-head">Move to…</div>
                                    {#each categoriesForMove as moveCat (moveCat.id)}
                                      {@const isChild = !!moveCat.parent_id}
                                      {@const parentCat = isChild ? categories.find(c => c.id === moveCat.parent_id) : null}
                                      <button class="rr-move-opt"
                                              class:child={isChild}
                                              class:current={moveCat.id === feed.category_id}
                                              on:click={() => moveFeedTo(feed.id, moveCat.id)}>
                                        <span class="rr-move-opt-icon">{moveCat.icon || '•'}</span>
                                        <span class="rr-move-opt-name">
                                          {#if isChild && parentCat}<span class="rr-move-opt-parent">{parentCat.name} ›</span>{/if}{displayCatName(moveCat)}
                                        </span>
                                        {#if moveCat.id === feed.category_id}<span class="rr-move-opt-tick">✓</span>{/if}
                                      </button>
                                    {/each}
                                    <button class="rr-move-opt"
                                            class:current={!feed.category_id}
                                            on:click={() => moveFeedTo(feed.id, '__uncat__')}>
                                      <span class="rr-move-opt-icon">○</span>
                                      <span class="rr-move-opt-name">Uncategorized</span>
                                      {#if !feed.category_id}<span class="rr-move-opt-tick">✓</span>{/if}
                                    </button>
                                  </div>
                                {/if}
                              </li>
                            {/each}
                          </ul>
                        {/if}
                      </div>
                    {/if}
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        {/if}
      {/each}

      <!-- New folder button -->
      {#if creatingCat}
        <div class="rr-cat new">
          <div class="rr-cat-row">
            <div class="rr-cat-main">
              <span class="rr-cat-icon">📁</span>
              <input class="rr-cat-input"
                     placeholder="Folder name…"
                     bind:value={newCatName}
                     on:keydown={onNewCatKey}
                     use:focusOnMount />
            </div>
            <button class="rr-cat-action ok" title="Create" on:click={commitNewCat}>✓</button>
            <button class="rr-cat-action" title="Cancel" on:click={() => { creatingCat = false; newCatName = ''; }}>✕</button>
          </div>
        </div>
      {:else}
        <button class="rr-add-cat" on:click={() => { creatingCat = true; newCatName = ''; }}>
          + New folder
        </button>
      {/if}
    </div>
  </aside>

  <!-- ═══════════════════ Middle: Inbox ═══════════════════ -->
  <section class="rr-list">
    <header class="rr-list-head">
      <div class="rr-tabs">
        <button class="rr-tab" class:active={activeFilter === 'unread'} on:click={() => setFilter('unread')}>
          Unread<span class="rr-tab-num">{stats.unread}</span>
        </button>
        <button class="rr-tab" class:active={activeFilter === 'today'} on:click={() => setFilter('today')}>
          Today<span class="rr-tab-num">{stats.unread_today}</span>
        </button>
        <button class="rr-tab" class:active={activeFilter === 'starred'} on:click={() => setFilter('starred')}>
          ★<span class="rr-tab-num">{stats.starred}</span>
        </button>
        <button class="rr-tab" class:active={activeFilter === 'all'} on:click={() => setFilter('all')}>
          All<span class="rr-tab-num">{stats.total_items}</span>
        </button>
      </div>
      <button class="rr-mark-all" on:click={markAllRead} title="Mark all visible as read">✓ All</button>
      <button class="rr-mark-all" on:click={refreshAll} disabled={refreshing} title="Fetch new items (Cmd+R)">
        <span class:spinning={refreshing}>↻</span>
      </button>
    </header>

    <div class="rr-list-body">
      {#if loading}
        <div class="rr-state">
          <div class="rr-spinner"></div>
          <div class="rr-state-msg">Composing your inbox…</div>
        </div>
      {:else if filteredItems.length === 0}
        <div class="rr-state">
          <div class="rr-state-glyph">{activeFilter === 'starred' ? '☆' : activeFilter === 'today' ? '◌' : '✓'}</div>
          <div class="rr-state-title">
            {activeFilter === 'unread' ? 'Inbox zero' :
             activeFilter === 'starred' ? 'Nothing starred' :
             activeFilter === 'today' ? 'Quiet today' : 'No matches'}
          </div>
          <div class="rr-state-sub">
            {activeFilter === 'unread' ? 'Nicely done.' :
             activeFilter === 'starred' ? 'Star items to find them here later.' :
             activeFilter === 'today' ? 'No new pieces yet.' : 'Try adjusting your filters.'}
          </div>
          {#if items.length === 0}
            <button class="rr-cta" on:click={refreshAll}>Fetch feeds now</button>
          {/if}
        </div>
      {:else}
        <div class="rr-list-meta">
          <span class="rr-list-count">{filteredItems.length.toString().padStart(3, '0')}</span>
          <span class="rr-list-rule"></span>
          {#if activeFeedId}
            {@const f = feeds.find(x => x.id === activeFeedId)}
            <span class="rr-list-scope">{f?.name ?? 'feed'}</span>
            <button class="rr-list-icon" on:click={() => refreshSingle(activeFeedId)} title="Refresh feed">↻</button>
          {:else if activeCategoryId}
            {@const c = categories.find(x => x.id === activeCategoryId)}
            <span class="rr-list-scope">{c?.name ?? 'category'}</span>
          {:else}
            <span class="rr-list-scope">All sources</span>
          {/if}
        </div>
        <ol class="rr-items">
          {#each filteredItems as item (item.id)}
            <li>
              <button class="rr-item"
                      class:active={selectedItem?.id === item.id}
                      class:unread={!item.read}
                      on:click={() => selectItem(item)}>
                <span class="rr-item-pulse" class:on={!item.read}></span>
                <span class="rr-item-source">{item.feed_name}</span>
                <span class="rr-item-title">{item.title || '(untitled)'}</span>
                {#if item.starred}<span class="rr-item-star">★</span>{/if}
                <span class="rr-item-time">{timeAgo(item.published_at ?? item.fetched_at)}</span>
              </button>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </section>

  <!-- ═══════════════════ Right: Article (only when item selected) ═══════════════════ -->
  {#if selectedItem}
    {@const it = selectedItem}
    <main class="rr-read">
      {#key it.id}
        <article class="rr-article">
          <div class="rr-art-rail">
            <button class="rr-rail-btn" title="Close (Esc)" on:click={() => selectedItem = null}>✕</button>
            <button class="rr-rail-btn" class:on={!!it.starred} title={it.starred ? 'Unstar' : 'Star'} on:click={() => toggleStar(it)}>★</button>
            <button class="rr-rail-btn" title={it.read ? 'Mark unread' : 'Mark read'} on:click={() => toggleRead(it)}>
              {it.read ? '↺' : '✓'}
            </button>
            <a class="rr-rail-btn" href={it.link} target="_blank" rel="noopener" title="Open original">↗</a>
          </div>

          <header class="rr-art-head">
            <div class="rr-art-eyebrow">
              <span class="rr-art-source">{it.feed_name}</span>
              {#if it.category_name}
                <span class="rr-art-divider"></span>
                <span class="rr-art-cat" style="color:{categoryColorFor(it.category_name)}">
                  {it.category_icon ? it.category_icon + ' ' : ''}{it.category_name}
                </span>
              {/if}
              <span class="rr-art-divider"></span>
              <span class="rr-art-time">{timeAgo(it.published_at ?? it.fetched_at)}</span>
            </div>

            <h1 class="rr-art-title">{it.title || '(untitled)'}</h1>

            {#if it.author}
              <div class="rr-art-byline">By <em>{it.author}</em></div>
            {/if}
          </header>

          {#if it.image_url}
            <figure class="rr-art-hero">
              <img src={it.image_url} alt="" />
            </figure>
          {/if}

          <div class="rr-art-body">
            {@html safeHtml(it.content || it.description || '')}
          </div>

          <footer class="rr-art-foot">
            <a class="rr-cta" href={it.link} target="_blank" rel="noopener">
              Continue reading on {it.feed_name}
              <span class="rr-cta-arrow">→</span>
            </a>
          </footer>
        </article>
      {/key}
    </main>
  {/if}
</div>

<style>
  /* ──────────────────────────────────────────────────────────────
     Editorial RSS Reader — position-fixed, full-viewport layout
     anchored below the global header & right of the global app
     sidebar. This bypasses any flex/grid inheritance issues from
     parent layout containers. Always fills available viewport.
     ────────────────────────────────────────────────────────────── */
  /* Default state (no article selected): 2 columns — sidebar + wide list.
     When an item is selected, `.reading` is added and the grid expands to
     3 columns with the article pane appearing on the right. The list
     shrinks via the same grid transition.
     The columns transition smoothly via grid-template-columns. */
  .rr {
    position: fixed;
    top: var(--header-h, 56px);
    left: var(--sidebar-w, 72px);
    right: 0;
    bottom: 0;
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    background: var(--bg);
    color: var(--text-1);
    font-family: var(--font-body);
    overflow: hidden;
    transition: grid-template-columns 350ms cubic-bezier(0.2, 0.8, 0.2, 1);
    /* subtle paper grain */
    background-image:
      radial-gradient(ellipse at 20% 10%, rgba(212, 168, 75, 0.025), transparent 50%),
      radial-gradient(ellipse at 80% 90%, rgba(91, 155, 247, 0.018), transparent 60%);
  }
  .rr.reading {
    grid-template-columns: 280px 440px minmax(0, 1fr);
  }
  @media (max-width: 1400px) {
    .rr            { grid-template-columns: 240px minmax(0, 1fr); }
    .rr.reading    { grid-template-columns: 240px 400px minmax(0, 1fr); }
  }
  @media (max-width: 1100px) {
    .rr            { grid-template-columns: 200px minmax(0, 1fr); }
    .rr.reading    { grid-template-columns: 200px 360px minmax(0, 1fr); }
  }
  @media (max-width: 860px) {
    .rr            { grid-template-columns: 180px minmax(0, 1fr); }
    .rr.reading    { grid-template-columns: 180px 1fr 0; }
    .rr.reading .rr-list { display: none; } /* On tiny screens the list is hidden when reading */
  }

  /* ═══════════════════════════ SIDEBAR ═══════════════════════════ */
  .rr-sb {
    background: var(--surface-1);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    min-height: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinning { display: inline-block; animation: spin 0.9s linear infinite; }

  .rr-sb-body {
    flex: 1; min-height: 0;
    overflow-y: auto;
    padding: 12px 6px 24px;
  }
  .rr-sb-body::-webkit-scrollbar { width: 3px; }
  .rr-sb-body::-webkit-scrollbar-thumb {
    background: var(--border-h);
    border-radius: 2px;
  }

  .rr-back {
    width: calc(100% - 8px);
    margin: 0 4px 8px;
    background: transparent;
    border: none;
    color: var(--text-3);
    padding: 6px 8px;
    font-size: 11px;
    font-family: var(--font-mono);
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    display: flex; align-items: center; gap: 6px;
    text-align: left;
    transition: color .15s;
  }
  .rr-back:hover { color: var(--gold); }
  .rr-back-arrow { font-size: 14px; }

  /* ── Categories ── */
  .rr-cat {
    margin-bottom: 1px;
    border-radius: 4px;
    transition: background .15s, box-shadow .15s;
    position: relative;
  }
  .rr-cat.drop {
    background: rgba(212, 168, 75, 0.08);
    box-shadow: inset 0 0 0 1px var(--gold);
  }
  /* Visual reorder indicator: 2px gold line above/below the row when a
     dragged category is hovering at top/bottom half. */
  .rr-cat.drop-cat-before::before,
  .rr-cat.drop-cat-after::after {
    content: '';
    position: absolute;
    left: 4px; right: 4px;
    height: 2px;
    background: var(--gold);
    box-shadow: 0 0 6px rgba(212, 168, 75, 0.6);
    pointer-events: none;
    z-index: 2;
  }
  .rr-cat.drop-cat-before::before { top: -1px; }
  .rr-cat.drop-cat-after::after  { bottom: -1px; }
  .rr-cat.dragging { opacity: 0.45; }
  /* Tiny grip handle on the left of the category row. Opacity 0 until you
     hover the row, so the resting tree stays clean. */
  .rr-cat-grip {
    flex-shrink: 0;
    width: 12px;
    align-self: stretch;
    display: grid; place-items: center;
    color: var(--text-3);
    font-size: 10px;
    letter-spacing: -2px;
    opacity: 0;
    cursor: grab;
    transition: opacity .15s, color .15s;
    user-select: none;
  }
  .rr-cat-row:hover .rr-cat-grip { opacity: 0.55; }
  .rr-cat-grip:hover { color: var(--gold); opacity: 1; }
  .rr-cat-grip:active { cursor: grabbing; }

  /* ── Sub-category tree level ── */
  /* Wrapper holding all child folders. Indented + a left guide-line so the
     hierarchy is unmistakable at a glance. */
  .rr-subcats {
    margin-left: 16px;
    padding-left: 6px;
    border-left: 1px solid var(--border);
    margin-top: 1px;
  }
  .rr-cat-child {
    margin-bottom: 0;
  }
  .rr-cat-row-child .rr-cat-main {
    padding: 6px 8px;
    font-size: 12px;
    font-weight: 400;
    color: var(--text-2);
  }
  .rr-cat-icon-sm {
    font-size: 12px !important;
    width: 14px !important; height: 14px !important;
  }
  /* Counter showing how many sub-folders a parent has, nestled between the
     name and the unread badge. Same style language as `--cat-num` but
     monochrome to stay quieter. */
  .rr-cat-kidnum {
    font-family: var(--font-mono);
    font-size: 9px;
    font-feature-settings: 'tnum';
    color: var(--text-3);
    background: var(--surface-2);
    padding: 1px 5px;
    border-radius: 8px;
    margin-left: 6px;
    flex-shrink: 0;
    line-height: 1.3;
    letter-spacing: 0.4px;
  }
  .rr-cat-row.has-children .rr-cat-name {
    /* Slightly bolder for parents that group children — easier to scan the
       structure top-to-bottom. */
    font-weight: 600;
  }
  .rr-feeds-child {
    /* Slight extra indent so the feeds inside a sub-category line up after
       the guide-line. */
    margin-left: 0;
  }
  .rr-feed-child {
    padding-left: 28px;
  }
  /* Row is the wrapping flex container: a main button + 0-2 action buttons */
  .rr-cat-row {
    display: flex; align-items: stretch;
    border-radius: 4px;
    position: relative;
    transition: background .15s;
  }
  .rr-cat-row:hover { background: var(--surface-2); }
  .rr-cat-row.active {
    background: var(--surface-2);
  }
  .rr-cat-row.active::before {
    content: '';
    position: absolute;
    left: -6px; top: 8px; bottom: 8px;
    width: 2px;
    background: var(--accent, var(--gold));
  }
  .rr-cat-main {
    flex: 1; min-width: 0;
    background: transparent;
    border: none;
    color: var(--text-1);
    display: flex; align-items: center; gap: 10px;
    padding: 9px 10px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    transition: color .15s;
  }
  .rr-cat-row.active .rr-cat-main {
    color: var(--accent, var(--gold));
  }
  .rr-cat-icon {
    font-size: 14px;
    width: 18px; height: 18px;
    display: grid; place-items: center;
    flex-shrink: 0;
  }
  .rr-cat-dot {
    width: 7px; height: 7px;
    background: var(--accent);
    border-radius: 50%;
  }
  .rr-cat-name {
    flex: 1; min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rr-cat-input {
    flex: 1; min-width: 0;
    background: var(--surface-2);
    border: 1px solid var(--gold);
    color: var(--text-1);
    padding: 3px 6px;
    border-radius: 3px;
    font-size: 12.5px;
    font-family: var(--font-body);
    font-weight: 500;
    outline: none;
  }
  .rr-cat-num {
    font-family: var(--font-mono);
    font-size: 10px;
    font-feature-settings: 'tnum';
    color: var(--text-3);
    background: transparent;
    padding: 0;
    flex-shrink: 0;
    min-width: 22px;
    text-align: right;
  }
  .rr-cat-row.active .rr-cat-num { color: var(--accent); }
  .rr-cat-chev {
    color: var(--text-3);
    font-size: 14px;
    line-height: 1;
    transition: transform .2s ease;
    flex-shrink: 0;
  }
  .rr-cat-chev.open {
    transform: rotate(90deg);
    color: var(--text-2);
  }
  /* Per-row inline actions (rename, delete, save, cancel). Hidden by default,
     fade in on hover or when the row is in edit mode. */
  .rr-cat-action {
    background: transparent;
    border: none;
    color: var(--text-3);
    width: 26px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    display: grid; place-items: center;
    margin: 4px 1px;
    transition: color .15s, background .15s, opacity .15s;
    flex-shrink: 0;
    opacity: 1;
  }
  .rr-cat-action.ghost { opacity: 0; }
  .rr-cat-row:hover .rr-cat-action.ghost { opacity: 1; }
  .rr-cat-action:hover { color: var(--text-1); background: var(--surface-3); }
  .rr-cat-action.ok { color: var(--green); }
  .rr-cat-action.ok:hover { background: rgba(61, 214, 140, 0.12); }
  .rr-cat-action.danger:hover { color: var(--red); background: rgba(240, 71, 112, 0.10); }

  /* + New folder button at the bottom of the sidebar */
  .rr-add-cat {
    width: calc(100% - 8px);
    margin: 12px 4px 0;
    background: transparent;
    border: 1px dashed var(--border);
    color: var(--text-3);
    padding: 8px 10px;
    border-radius: 4px;
    font-size: 11.5px;
    font-family: var(--font-mono);
    letter-spacing: 0.5px;
    cursor: pointer;
    text-align: left;
    transition: all .15s;
  }
  .rr-add-cat:hover {
    border-color: var(--gold);
    color: var(--gold);
    background: rgba(212, 168, 75, 0.04);
  }
  .rr-cat.new {
    margin-top: 4px;
    background: var(--surface-2);
    border-radius: 4px;
  }

  /* ── Feeds ── */
  .rr-feeds {
    list-style: none;
    margin: 2px 0 4px;
    padding: 0;
  }
  /* `<li>` wrapper. Holds the feed button + the drop-indicator pseudo-elements
     + the move-to-folder popover. The popover is absolutely positioned, so
     `position: relative` belongs here. */
  .rr-feed-row {
    position: relative;
  }
  .rr-feed-row.drop-before::before,
  .rr-feed-row.drop-after::after {
    content: '';
    position: absolute;
    left: 28px; right: 6px;
    height: 2px;
    background: var(--gold);
    box-shadow: 0 0 4px rgba(212, 168, 75, 0.55);
    pointer-events: none;
    z-index: 2;
  }
  .rr-feed-row.drop-before::before { top: -1px; }
  .rr-feed-row.drop-after::after  { bottom: -1px; }
  .rr-feed {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text-2);
    display: flex; align-items: flex-start; gap: 8px;
    padding: 5px 10px 5px 32px;
    font-size: 12.5px;
    line-height: 1.4;
    cursor: pointer;
    text-align: left;
    transition: color .15s, background .15s, opacity .15s;
    border-radius: 4px;
    position: relative;
  }
  .rr-feed.dragging { opacity: 0.4; }
  .rr-feed:hover { color: var(--text-1); background: rgba(255,255,255,0.02); }
  .rr-feed.active {
    color: var(--text-1);
    background: var(--surface-2);
  }
  /* Inline "move-to" trigger — hidden until you hover the feed row. The icon
     is intentionally low-key so it never competes with the feed name. */
  .rr-move-trigger {
    flex-shrink: 0;
    width: 18px; height: 18px;
    display: grid; place-items: center;
    color: var(--text-3);
    font-size: 12px;
    border-radius: 3px;
    opacity: 0;
    transition: opacity .15s, color .15s, background .15s;
    cursor: pointer;
    user-select: none;
  }
  .rr-feed:hover .rr-move-trigger { opacity: 0.7; }
  .rr-move-trigger:hover, .rr-move-trigger.on {
    opacity: 1;
    color: var(--gold);
    background: rgba(212, 168, 75, 0.12);
  }
  /* Popover anchored to the feed row. We use `right` so it never escapes the
     sidebar viewport on narrow screens; `top: 100%` puts it just below. */
  .rr-move-pop {
    position: absolute;
    top: calc(100% + 2px);
    right: 6px;
    min-width: 180px;
    max-width: 240px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    padding: 4px;
    z-index: 30;
  }
  .rr-move-pop-head {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-3);
    padding: 6px 8px 4px;
  }
  .rr-move-opt {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text-2);
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    transition: color .12s, background .12s;
  }
  .rr-move-opt:hover { color: var(--text-1); background: var(--surface-3); }
  .rr-move-opt.current { color: var(--gold); }
  .rr-move-opt-icon {
    width: 16px; flex-shrink: 0;
    display: grid; place-items: center;
    font-size: 13px;
  }
  .rr-move-opt-name {
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rr-move-opt-tick {
    flex-shrink: 0;
    color: var(--gold);
    font-size: 11px;
  }
  /* Child entries in the move-to popover get a faint parent breadcrumb
     prefix and a mild indent, so picking "Entertainment › Books" feels
     unambiguous even when the popover is dense. */
  .rr-move-opt.child .rr-move-opt-name { color: var(--text-2); }
  .rr-move-opt-parent {
    color: var(--text-3);
    font-size: 11px;
    margin-right: 4px;
    font-weight: 500;
  }
  .rr-feed-tick {
    position: absolute;
    left: 18px; top: 11px;
    width: 6px; height: 1px;
    background: var(--text-3);
    flex-shrink: 0;
  }
  .rr-feed.has-unread .rr-feed-tick {
    background: var(--accent, var(--gold));
    height: 2px;
  }
  .rr-feed-name {
    flex: 1; min-width: 0;
    word-break: break-word;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rr-feed-num {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum';
    font-size: 10px;
    color: var(--text-3);
    flex-shrink: 0;
    margin-top: 1px;
  }
  .rr-feed.active .rr-feed-num { color: var(--gold); }

  /* ═══════════════════════════ INBOX ═══════════════════════════ */
  .rr-list {
    background: var(--surface-1);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    min-height: 0;
  }
  .rr-list-head {
    flex-shrink: 0;
    display: flex; align-items: center; gap: 6px;
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }
  .rr-tabs {
    display: flex; gap: 2px;
    flex: 1; min-width: 0;
    overflow-x: auto;
  }
  .rr-tabs::-webkit-scrollbar { height: 0; display: none; }
  .rr-tab {
    background: transparent;
    border: none;
    color: var(--text-3);
    padding: 5px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    display: inline-flex; align-items: center; gap: 5px;
    cursor: pointer;
    transition: color .15s, background .15s;
    flex-shrink: 0;
  }
  .rr-tab:hover { color: var(--text-1); background: var(--surface-2); }
  .rr-tab.active {
    color: var(--text-1);
    background: var(--surface-2);
  }
  .rr-tab.active::after {
    content: '';
    display: inline-block;
    width: 4px; height: 4px;
    background: var(--gold);
    border-radius: 50%;
    margin-left: 1px;
  }
  .rr-tab-num {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum';
    font-size: 10px;
    font-weight: 500;
    color: var(--text-3);
    letter-spacing: 0;
  }
  .rr-tab.active .rr-tab-num { color: var(--text-2); }
  .rr-mark-all {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-3);
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-family: var(--font-mono);
    letter-spacing: 0.5px;
    cursor: pointer;
    flex-shrink: 0;
    transition: all .15s;
  }
  .rr-mark-all:hover {
    border-color: var(--green);
    color: var(--green);
  }

  .rr-list-body {
    flex: 1; min-height: 0;
    overflow-y: auto;
  }
  .rr-list-body::-webkit-scrollbar { width: 4px; }
  .rr-list-body::-webkit-scrollbar-thumb {
    background: var(--border-h);
    border-radius: 2px;
  }

  .rr-list-meta {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px 8px;
    font-size: 10px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 1.5px;
    font-family: var(--font-mono);
    position: sticky; top: 0;
    background: var(--surface-1);
    z-index: 5;
    border-bottom: 1px solid var(--border);
  }
  .rr-list-count {
    color: var(--gold);
    font-weight: 500;
    font-feature-settings: 'tnum';
  }
  .rr-list-rule {
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, var(--border) 0%, transparent 100%);
  }
  .rr-list-scope {
    color: var(--text-2);
    text-transform: none;
    letter-spacing: 0;
    font-family: var(--font-body);
    font-size: 11px;
  }
  .rr-list-icon {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    font-size: 13px;
  }
  .rr-list-icon:hover { color: var(--gold); }

  .rr-items {
    list-style: none;
    margin: 0; padding: 0;
  }
  /* ── Single-line item rows ──
     Each item is a horizontal flex row: pulse · feed · title (flex:1) · star · time
     The title takes all remaining space and truncates with ellipsis. The whole
     row stays at one line height — no description, no thumbnail. */
  .rr-item {
    width: 100%;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-1);
    text-align: left;
    padding: 10px 18px;
    cursor: pointer;
    transition: background .15s ease, padding .25s ease;
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    line-height: 1.4;
  }
  .rr-item:hover {
    background: var(--surface-2);
  }
  .rr-item.active {
    background: linear-gradient(90deg, rgba(212, 168, 75, 0.14), rgba(212, 168, 75, 0.02) 60%, transparent);
  }
  .rr-item.active::before {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 2px;
    background: var(--gold);
  }

  .rr-item-pulse {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: transparent;
    flex-shrink: 0;
    transition: background .15s, box-shadow .15s;
  }
  .rr-item-pulse.on {
    background: var(--gold);
    box-shadow: 0 0 6px rgba(212, 168, 75, 0.55);
  }

  .rr-item-source {
    flex-shrink: 0;
    width: 160px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rr-item.unread .rr-item-source { color: var(--text-2); }
  .rr-item.active .rr-item-source { color: var(--gold); }

  .rr-item-title {
    flex: 1;
    min-width: 0;
    font-family: var(--font-body);
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .rr-item.unread .rr-item-title {
    color: var(--text-1);
    font-weight: 600;
  }
  .rr-item.active .rr-item-title {
    color: var(--text-1);
    font-weight: 700;
  }

  .rr-item-star {
    flex-shrink: 0;
    color: var(--gold);
    font-size: 11px;
    line-height: 1;
  }
  .rr-item-time {
    flex-shrink: 0;
    width: 56px;
    text-align: right;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-feature-settings: 'tnum';
    letter-spacing: 0.3px;
  }

  /* Reading mode: list is narrower. Drop the feed-name column there to
     give the title more breathing room (it's redundant with the article
     pane's eyebrow anyway). */
  .rr.reading .rr-item-source {
    width: 96px;
    font-size: 9.5px;
  }
  .rr.reading .rr-item-time { width: 40px; font-size: 9.5px; }
  .rr.reading .rr-item { padding: 9px 14px; gap: 10px; }
  @media (max-width: 1100px) {
    .rr.reading .rr-item-source { display: none; }
  }

  /* ═══════════════════════════ READER ═══════════════════════════ */
  .rr-read {
    background: var(--bg);
    overflow-y: auto;
    position: relative;
  }
  .rr-read::-webkit-scrollbar { width: 6px; }
  .rr-read::-webkit-scrollbar-thumb {
    background: var(--border-h);
    border-radius: 3px;
  }

  .rr-article {
    max-width: 760px;
    margin: 0 auto;
    padding: 56px 48px 80px;
    position: relative;
    animation: artFadeIn 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes artFadeIn {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: none; }
  }

  .rr-art-rail {
    position: sticky;
    top: 24px;
    float: right;
    margin-left: 20px;
    margin-bottom: 20px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .rr-rail-btn {
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-3);
    width: 36px; height: 36px;
    border-radius: 50%;
    font-size: 14px;
    cursor: pointer;
    display: grid; place-items: center;
    transition: all .15s;
    text-decoration: none;
  }
  .rr-rail-btn:hover {
    border-color: var(--gold);
    color: var(--gold);
    transform: translateY(-1px);
  }
  .rr-rail-btn.on {
    background: rgba(212, 168, 75, 0.12);
    border-color: var(--gold);
    color: var(--gold);
  }

  .rr-art-head { margin-bottom: 28px; }
  .rr-art-eyebrow {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 18px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 1.6px;
    flex-wrap: wrap;
  }
  .rr-art-source {
    color: var(--text-1);
    font-weight: 500;
  }
  .rr-art-cat { font-weight: 500; }
  .rr-art-time {
    color: var(--text-3);
    font-feature-settings: 'tnum';
  }
  .rr-art-divider {
    width: 22px;
    height: 1px;
    background: var(--text-3);
    opacity: 0.4;
  }

  .rr-art-title {
    font-family: 'Crimson Pro', 'Iowan Old Style', Georgia, serif;
    font-size: clamp(32px, 4.6vw, 56px);
    font-weight: 700;
    line-height: 1.05;
    letter-spacing: -0.018em;
    color: var(--text-1);
    margin-bottom: 14px;
    text-wrap: balance;
  }

  .rr-art-byline {
    font-family: 'Crimson Pro', Georgia, serif;
    font-size: 16px;
    color: var(--text-2);
    font-style: normal;
    margin-top: 2px;
  }
  .rr-art-byline em {
    font-style: italic;
    color: var(--text-1);
  }

  .rr-art-hero {
    margin: 32px 0 36px;
    border-radius: 2px;
    overflow: hidden;
    background: var(--surface-2);
    box-shadow: 0 30px 60px -20px rgba(0, 0, 0, 0.5);
    max-height: 460px;
  }
  .rr-art-hero img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
  }

  /* Article body — set in serif for reading */
  .rr-art-body {
    font-family: 'Crimson Pro', 'Iowan Old Style', Georgia, serif;
    font-size: 19px;
    line-height: 1.65;
    color: var(--text-1);
    font-weight: 400;
  }
  .rr-art-body :global(p) {
    margin-bottom: 1.1em;
    text-wrap: pretty;
  }
  .rr-art-body :global(p:first-of-type::first-letter) {
    font-family: 'Crimson Pro', Georgia, serif;
    font-size: 4.5em;
    font-weight: 700;
    float: left;
    line-height: 0.85;
    margin: 0.08em 0.08em 0 -0.04em;
    color: var(--gold);
  }
  .rr-art-body :global(a) {
    color: var(--text-1);
    text-decoration: none;
    background-image: linear-gradient(transparent calc(100% - 1px), var(--gold) 1px);
    background-size: 100% 100%;
    background-repeat: no-repeat;
    transition: background-size .3s;
    padding: 1px 0;
  }
  .rr-art-body :global(a:hover) {
    background-size: 100% 24%;
    background-image: linear-gradient(transparent 76%, rgba(212, 168, 75, 0.25) 76%);
  }
  .rr-art-body :global(img) {
    max-width: 100%;
    height: auto;
    margin: 28px auto;
    display: block;
    border-radius: 2px;
  }
  .rr-art-body :global(blockquote) {
    border-left: 2px solid var(--gold);
    padding: 6px 0 6px 20px;
    margin: 28px 0;
    font-style: italic;
    color: var(--text-2);
    font-size: 1.05em;
  }
  .rr-art-body :global(pre) {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 16px;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    margin: 24px 0;
  }
  .rr-art-body :global(code) {
    background: var(--surface-2);
    padding: 1px 6px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 0.85em;
  }
  .rr-art-body :global(h2),
  .rr-art-body :global(h3) {
    font-family: 'Crimson Pro', Georgia, serif;
    font-weight: 700;
    margin-top: 1.6em;
    margin-bottom: 0.5em;
    line-height: 1.2;
  }
  .rr-art-body :global(h2) { font-size: 1.5em; }
  .rr-art-body :global(h3) { font-size: 1.25em; }
  .rr-art-body :global(ul),
  .rr-art-body :global(ol) {
    margin: 0 0 1.1em 1.4em;
  }
  .rr-art-body :global(li) {
    margin-bottom: 0.4em;
  }

  .rr-art-foot {
    margin-top: 48px;
    padding-top: 28px;
    border-top: 1px solid var(--border);
  }

  .rr-cta {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    background: transparent;
    border: 1px solid var(--gold);
    color: var(--gold);
    padding: 12px 22px;
    border-radius: 2px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    text-decoration: none;
    cursor: pointer;
    transition: all .2s;
  }
  .rr-cta:hover {
    background: var(--gold);
    color: #1a1410;
  }
  .rr-cta-arrow {
    transition: transform .2s;
  }
  .rr-cta:hover .rr-cta-arrow { transform: translateX(4px); }

  /* ── Loading / empty states for inbox ── */
  .rr-state {
    height: 100%;
    display: flex; flex-direction: column;
    justify-content: center; align-items: center;
    padding: 40px 24px;
    text-align: center;
    gap: 8px;
  }
  .rr-state-glyph {
    font-size: 36px;
    color: var(--text-3);
    margin-bottom: 8px;
    opacity: 0.6;
    font-weight: 300;
  }
  .rr-state-title {
    font-family: 'Crimson Pro', Georgia, serif;
    font-size: 22px;
    font-weight: 600;
    color: var(--text-1);
    letter-spacing: -0.01em;
  }
  .rr-state-msg,
  .rr-state-sub {
    font-size: 13px;
    color: var(--text-3);
    font-style: italic;
  }
  .rr-spinner {
    width: 20px; height: 20px;
    border: 2px solid var(--border);
    border-top-color: var(--gold);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 6px;
  }

</style>

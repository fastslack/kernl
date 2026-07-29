<script lang="ts">
  // /x-manager — migrated from services/dashboard/src/routes/x-manager/+page.svelte
  // (Fase 2b). All data flows through ctx.rpc with HTTP fallbacks against the
  // twitter module's API routes (rpcOrCall semantics preserved; fallbacks now
  // carry the kernel auth token via ctx.fetchRaw).
  import { onMount } from 'svelte';
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import Badge from '$shared/components/Badge.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import { fmtTime } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const rpcOrCall = (action: string, params: Record<string, unknown>, fallback: () => Promise<any>) =>
    ctx.rpc(action, params, fallback);

  // ── State ──────────────────────────────────────
  let tw: any = null;
  let loading = true;
  let tab: 'posts' | 'queue' | 'mentions' | 'accounts' | 'metrics' = 'posts';

  // Post editor
  let showEditor = false;
  let editingPost: any = null;
  let editorContent = '';
  let editorType: 'tweet' | 'reply' | 'thread' | 'quote' = 'tweet';
  let editorAccountId = '';
  let editorSchedule = '';
  let editorStatus: 'draft' | 'queued' = 'queued';
  let saving = false;

  // Account editor
  let showAccountEditor = false;
  let editingAccount: any = null;
  let accHandle = '';
  let accDisplayName = '';
  let accApiKey = '';
  let accApiSecret = '';
  let accAccessToken = '';
  let accAccessSecret = '';

  // Detail panel
  let selectedPost: any = null;

  // Action states
  let publishing = new Set<string>();
  let approving = new Set<string>();
  let syncing = false;

  $: kpis = tw?.kpis ?? {};
  $: accounts = tw?.accounts ?? [];
  $: recentPosts = tw?.recentPosts ?? [];
  $: scheduledPosts = tw?.scheduledPosts ?? [];
  $: recentMentions = tw?.recentMentions ?? [];
  $: latestMetrics = tw?.latestMetrics ?? [];
  $: postsByStatus = tw?.postsByStatus ?? [];
  $: postsByType = tw?.postsByType ?? [];

  // Filtered posts by tab
  $: displayPosts = (() => {
    if (tab === 'queue') return recentPosts.filter((p: any) => p.status === 'queued' || p.status === 'approved');
    return recentPosts;
  })();

  // ── Data loading ───────────────────────────────
  async function reload() {
    try {
      tw = await rpcOrCall('dashboard.twitter', {}, async () => {
        const res = await ctx.fetchRaw('/api/dashboard/twitter');
        return res.json();
      });
    } catch { /* ignore */ }
    loading = false;
  }

  onMount(() => { reload(); });

  // ── Post Actions ───────────────────────────────
  async function approvePost(id: string) {
    approving = new Set([...approving, id]);
    try {
      await rpcOrCall('twitter.posts.approve', { id }, () =>
        ctx.fetchRaw('/api/twitter/posts/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        }).then(r => r.json())
      );
      await reload();
    } catch { /* ignore */ }
    approving = new Set([...approving].filter(x => x !== id));
  }

  async function publishPost(id: string) {
    publishing = new Set([...publishing, id]);
    try {
      const data: any = await rpcOrCall('twitter.posts.publish', { id }, () =>
        ctx.fetchRaw('/api/twitter/posts/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        }).then(r => r.json())
      );
      if (!data.ok) alert('Publish failed: ' + (data.error || 'Unknown error'));
      await reload();
    } catch { /* ignore */ }
    publishing = new Set([...publishing].filter(x => x !== id));
  }

  async function deletePost(id: string) {
    if (!confirm('Delete this post?')) return;
    try {
      await rpcOrCall('twitter.posts.delete', { id }, () =>
        ctx.fetchRaw('/api/twitter/posts/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        }).then(r => r.json())
      );
      selectedPost = null;
      await reload();
    } catch { /* ignore */ }
  }

  // ── Post Editor ────────────────────────────────
  function openEditor(post?: any) {
    if (post) {
      editingPost = post;
      editorContent = post.content;
      editorType = post.post_type;
      editorAccountId = post.account_id;
      editorSchedule = post.scheduled_at?.slice(0, 16) ?? '';
      editorStatus = post.status === 'queued' ? 'queued' : 'draft';
    } else {
      editingPost = null;
      editorContent = '';
      editorType = 'tweet';
      editorAccountId = accounts[0]?.id ?? '';
      editorSchedule = '';
      editorStatus = 'queued';
    }
    showEditor = true;
  }

  async function savePost() {
    if (!editorContent.trim() || !editorAccountId) return;
    saving = true;
    try {
      if (editingPost) {
        const payload = {
          id: editingPost.id,
          content: editorContent,
          post_type: editorType,
          scheduled_at: editorSchedule || null,
          status: editorStatus,
        };
        await rpcOrCall('twitter.posts.update', payload, () =>
          ctx.fetchRaw('/api/twitter/posts/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }).then(r => r.json())
        );
      } else {
        const payload = {
          account_id: editorAccountId,
          content: editorContent,
          post_type: editorType,
          status: editorStatus,
          scheduled_at: editorSchedule || undefined,
        };
        await rpcOrCall('twitter.posts.create', payload, () =>
          ctx.fetchRaw('/api/twitter/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }).then(r => r.json())
        );
      }
      showEditor = false;
      await reload();
    } catch { /* ignore */ }
    saving = false;
  }

  // ── Account Editor ─────────────────────────────
  function openAccountEditor(acc?: any) {
    if (acc) {
      editingAccount = acc;
      accHandle = acc.handle;
      accDisplayName = acc.display_name;
      accApiKey = acc.api_key;
      accApiSecret = acc.api_secret;
      accAccessToken = acc.access_token;
      accAccessSecret = acc.access_secret;
    } else {
      editingAccount = null;
      accHandle = '';
      accDisplayName = '';
      accApiKey = '';
      accApiSecret = '';
      accAccessToken = '';
      accAccessSecret = '';
    }
    showAccountEditor = true;
  }

  async function saveAccount() {
    if (!accHandle.trim()) return;
    saving = true;
    try {
      if (editingAccount) {
        const payload = {
          id: editingAccount.id,
          handle: accHandle,
          display_name: accDisplayName,
          api_key: accApiKey,
          api_secret: accApiSecret,
          access_token: accAccessToken,
          access_secret: accAccessSecret,
        };
        await rpcOrCall('twitter.accounts.update', payload, () =>
          ctx.fetchRaw('/api/twitter/accounts/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }).then(r => r.json())
        );
      } else {
        const payload = {
          handle: accHandle,
          display_name: accDisplayName,
          api_key: accApiKey,
          api_secret: accApiSecret,
          access_token: accAccessToken,
          access_secret: accAccessSecret,
        };
        await rpcOrCall('twitter.accounts.create', payload, () =>
          ctx.fetchRaw('/api/twitter/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }).then(r => r.json())
        );
      }
      showAccountEditor = false;
      await reload();
    } catch { /* ignore */ }
    saving = false;
  }

  // ── Metrics Sync ───────────────────────────────
  async function syncMetrics(accountId: string) {
    syncing = true;
    try {
      await rpcOrCall('twitter.syncMetrics', { account_id: accountId }, () =>
        ctx.fetchRaw('/api/twitter/sync-metrics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: accountId })
        }).then(r => r.json())
      );
      await reload();
    } catch { /* ignore */ }
    syncing = false;
  }

  async function checkMentions(accountId: string) {
    try {
      const data: any = await rpcOrCall('twitter.checkMentions', { account_id: accountId }, () =>
        ctx.fetchRaw('/api/twitter/check-mentions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: accountId })
        }).then(r => r.json())
      );
      if (data.new_mentions > 0) alert(`Found ${data.new_mentions} new mention(s)`);
      await reload();
    } catch { /* ignore */ }
  }

  // ── Helpers ────────────────────────────────────
  function statusColor(s: string): string {
    const m: Record<string, string> = {
      draft: 'var(--text-2)', queued: 'var(--gold)', approved: 'var(--green)',
      posted: 'var(--blue)', failed: 'var(--red)',
    };
    return m[s] ?? 'var(--text-2)';
  }

  function charClass(len: number): string {
    if (len > 280) return 'over';
    if (len > 250) return 'warn';
    return 'ok';
  }

  function fmtNum(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  function fetchPerformance(accountId: string, days = 30) {
    return rpcOrCall('twitter.performance', { account_id: accountId, days }, () =>
      ctx.fetchRaw(`/api/twitter/performance?account_id=${accountId}&days=${days}`).then(r => r.json())
    );
  }
</script>

<ViewHeader title="X Manager" sub="Content pipeline for X/Twitter">
  <div class="header-actions">
    <button class="btn-sm" on:click={() => openEditor()}>+ New Post</button>
    <button class="btn-sm btn-ghost" on:click={reload}>↻</button>
  </div>
</ViewHeader>

{#if loading}
  <Panel cls="anim"><Empty message="Loading X data..." /></Panel>
{:else if !tw || !tw.available && accounts.length === 0}
  <Panel cls="anim"><Empty message="No X accounts configured. Add one to get started." /></Panel>
{:else}

<!-- KPIs -->
<div class="kpi-row anim">
  <KpiCard label="Accounts" value={kpis.activeAccounts ?? 0} sub="{kpis.accounts ?? 0} total" accent="--blue" />
  <KpiCard label="Queued" value={kpis.queued ?? 0} sub="pending review" accent="--gold" />
  <KpiCard label="Drafts" value={kpis.drafts ?? 0} accent="--text-2" />
  <KpiCard label="Posted" value={kpis.posted ?? 0} sub="today: {kpis.postedToday ?? 0}" accent="--green" />
  <KpiCard label="Failed" value={kpis.failed ?? 0} accent="--red" />
  <KpiCard label="Impressions" value={fmtNum(kpis.totalImpressions ?? 0)} accent="--purple" />
  <KpiCard label="Likes" value={fmtNum(kpis.totalLikes ?? 0)} accent="--orange" />
  <KpiCard label="Mentions" value={kpis.unreadMentions ?? 0} sub="unread" accent="--teal" />
</div>

<!-- Tabs -->
<div class="tab-row anim d1">
  {#each [
    { id: 'posts', label: 'All Posts' },
    { id: 'queue', label: `Queue (${kpis.queued ?? 0})` },
    { id: 'mentions', label: `Mentions (${kpis.unreadMentions ?? 0})` },
    { id: 'accounts', label: 'Accounts' },
    { id: 'metrics', label: 'Metrics' },
  ] as t}
    <button
      class="tab-btn"
      class:active={tab === t.id}
      on:click={() => { tab = t.id; selectedPost = null; }}
    >{t.label}</button>
  {/each}
</div>

<!-- Content area: list + detail -->
<div class="x-layout anim d2">

  <!-- POSTS TAB -->
  {#if tab === 'posts' || tab === 'queue'}
    <div class="x-list">
      {#if displayPosts.length === 0}
        <div class="empty-list">No posts {tab === 'queue' ? 'in queue' : 'found'}.</div>
      {/if}
      {#each displayPosts as post}
        <div
          class="post-card"
          class:selected={selectedPost?.id === post.id}
          on:click={() => selectedPost = post}
        >
          <div class="post-top">
            <span class="post-handle">@{post.account_handle || '?'}</span>
            <Badge text={post.status} />
            <Badge text={post.post_type} variant="muted" />
            <span class="post-chars" class:over={post.content.length > 280}>{post.content.length}/280</span>
          </div>
          <div class="post-content">{post.content.slice(0, 140)}{post.content.length > 140 ? '...' : ''}</div>
          <div class="post-meta">
            {#if post.scheduled_at}
              <span class="meta-tag">📅 {fmtTime(post.scheduled_at)}</span>
            {/if}
            {#if post.posted_at}
              <span class="meta-tag">✓ {fmtTime(post.posted_at)}</span>
            {/if}
            {#if post.status === 'posted'}
              <span class="meta-tag">❤ {post.metrics_likes}</span>
              <span class="meta-tag">🔄 {post.metrics_retweets}</span>
              <span class="meta-tag">👁 {fmtNum(post.metrics_impressions)}</span>
            {/if}
            <span class="meta-time">{fmtTime(post.created_at)}</span>
          </div>
        </div>
      {/each}
    </div>

    <!-- Detail panel -->
    <div class="x-detail">
      {#if selectedPost}
        <Panel title="Post Detail">
          <div class="detail-badges">
            <Badge text={selectedPost.status} />
            <Badge text={selectedPost.post_type} variant="muted" />
            <span class="post-handle">@{selectedPost.account_handle || '?'}</span>
          </div>

          <div class="detail-content">{selectedPost.content}</div>

          <div class="detail-chars {charClass(selectedPost.content.length)}">
            {selectedPost.content.length}/280 characters
          </div>

          {#if selectedPost.scheduled_at}
            <div class="detail-row">📅 Scheduled: {fmtTime(selectedPost.scheduled_at)}</div>
          {/if}
          {#if selectedPost.posted_at}
            <div class="detail-row">✓ Posted: {fmtTime(selectedPost.posted_at)}</div>
          {/if}
          {#if selectedPost.x_post_id}
            <div class="detail-row">🔗 <a href="https://x.com/i/web/status/{selectedPost.x_post_id}" target="_blank" rel="noopener">View on X</a></div>
          {/if}

          {#if selectedPost.status === 'posted'}
            <div class="metrics-grid">
              <div class="metric"><span class="metric-val">{fmtNum(selectedPost.metrics_impressions)}</span><span class="metric-label">Impressions</span></div>
              <div class="metric"><span class="metric-val">{selectedPost.metrics_likes}</span><span class="metric-label">Likes</span></div>
              <div class="metric"><span class="metric-val">{selectedPost.metrics_retweets}</span><span class="metric-label">Retweets</span></div>
              <div class="metric"><span class="metric-val">{selectedPost.metrics_replies}</span><span class="metric-label">Replies</span></div>
            </div>
          {/if}

          {#if selectedPost.error_message}
            <div class="detail-error">Error: {selectedPost.error_message}</div>
          {/if}

          <div class="detail-actions">
            {#if selectedPost.status === 'draft' || selectedPost.status === 'queued'}
              <button class="btn-sm" on:click={() => approvePost(selectedPost.id)}
                disabled={approving.has(selectedPost.id)}>
                {approving.has(selectedPost.id) ? 'Approving...' : '✓ Approve'}
              </button>
            {/if}
            {#if selectedPost.status === 'approved'}
              <button class="btn-sm btn-primary" on:click={() => publishPost(selectedPost.id)}
                disabled={publishing.has(selectedPost.id)}>
                {publishing.has(selectedPost.id) ? 'Publishing...' : '🚀 Publish Now'}
              </button>
            {/if}
            {#if selectedPost.status !== 'posted'}
              <button class="btn-sm btn-ghost" on:click={() => openEditor(selectedPost)}>✎ Edit</button>
              <button class="btn-sm btn-danger" on:click={() => deletePost(selectedPost.id)}>✕ Delete</button>
            {/if}
          </div>
        </Panel>
      {:else}
        <Panel>
          <div class="empty-detail">
            <div class="empty-icon">𝕏</div>
            <div>Select a post to see details</div>
            <button class="btn-sm" on:click={() => openEditor()} style="margin-top:1rem">+ New Post</button>
          </div>
        </Panel>
      {/if}

      <!-- Scheduled Posts -->
      {#if scheduledPosts.length > 0}
        <Panel title="Upcoming Scheduled" dotColor="var(--gold)">
          {#each scheduledPosts as sp}
            <div class="sched-item" on:click={() => selectedPost = sp}>
              <div class="sched-time">📅 {fmtTime(sp.scheduled_at)}</div>
              <div class="sched-content">{sp.content.slice(0, 80)}{sp.content.length > 80 ? '...' : ''}</div>
              <Badge text={sp.status} />
            </div>
          {/each}
        </Panel>
      {/if}

      <!-- Posts Breakdown -->
      <Panel title="Breakdown">
        <div class="breakdown-row">
          {#each postsByStatus as s}
            <div class="breakdown-item">
              <span class="breakdown-dot" style="background:{statusColor(s.status)}"></span>
              <span class="breakdown-label">{s.status}</span>
              <span class="breakdown-count">{s.count}</span>
            </div>
          {/each}
        </div>
        {#if postsByType.length > 0}
          <div class="breakdown-row" style="margin-top:0.5rem">
            {#each postsByType as t}
              <div class="breakdown-item">
                <span class="breakdown-label">{t.post_type}</span>
                <span class="breakdown-count">{t.count}</span>
              </div>
            {/each}
          </div>
        {/if}
      </Panel>
    </div>

  <!-- MENTIONS TAB -->
  {:else if tab === 'mentions'}
    <div class="x-list x-full">
      <div class="list-toolbar">
        {#each accounts.filter((a) => a.status === 'active') as acc}
          <button class="btn-sm btn-ghost" on:click={() => checkMentions(acc.id)}>Check @{acc.handle}</button>
        {/each}
      </div>
      {#if recentMentions.length === 0}
        <Empty message="No mentions yet." />
      {/if}
      {#each recentMentions as m}
        <div class="mention-card">
          <div class="mention-top">
            <span class="mention-author">@{m.author_handle}</span>
            <span class="mention-name">{m.author_name}</span>
            {#if m.replied}<Badge text="replied" variant="replied" />{:else}<Badge text="new" variant="new" />{/if}
          </div>
          <div class="mention-content">{m.content}</div>
          <div class="mention-meta">
            <span>{fmtTime(m.detected_at)}</span>
            <span>@{m.account_handle}</span>
          </div>
        </div>
      {/each}
    </div>

  <!-- ACCOUNTS TAB -->
  {:else if tab === 'accounts'}
    <div class="x-list x-full">
      <div class="list-toolbar">
        <button class="btn-sm" on:click={() => openAccountEditor()}>+ Add Account</button>
      </div>
      {#if accounts.length === 0}
        <Empty message="No accounts configured." />
      {/if}
      {#each accounts as acc}
        <div class="account-card">
          <div class="acc-top">
            <span class="acc-handle">@{acc.handle}</span>
            <span class="acc-name">{acc.display_name || ''}</span>
            <Badge text={acc.status} />
          </div>
          <div class="acc-creds">
            <span>API Key: {acc.api_key ? '✓ configured' : '✕ missing'}</span>
            <span>Access Token: {acc.access_token ? '✓ configured' : '✕ missing'}</span>
          </div>
          {#each latestMetrics.filter((m) => m.account_id === acc.id) as met}
            <div class="acc-metrics">
              <span>Followers: <strong>{fmtNum(met.followers)}</strong></span>
              <span>Following: <strong>{fmtNum(met.following)}</strong></span>
              <span>Tweets: <strong>{fmtNum(met.tweets_count)}</strong></span>
              <span class="meta-time">{met.snapshot_date}</span>
            </div>
          {/each}
          <div class="acc-actions">
            <button class="btn-sm btn-ghost" on:click={() => openAccountEditor(acc)}>✎ Edit</button>
            <button class="btn-sm btn-ghost" on:click={() => syncMetrics(acc.id)} disabled={syncing}>
              {syncing ? 'Syncing...' : '↻ Sync Metrics'}
            </button>
            <button class="btn-sm btn-ghost" on:click={() => checkMentions(acc.id)}>📬 Check Mentions</button>
          </div>
        </div>
      {/each}
    </div>

  <!-- METRICS TAB -->
  {:else if tab === 'metrics'}
    <div class="x-list x-full">
      {#each accounts.filter((a) => a.status === 'active') as acc}
        <Panel title="@{acc.handle}" dotColor="var(--blue)">
          {#each latestMetrics.filter((m) => m.account_id === acc.id) as met}
            <div class="metrics-grid big">
              <div class="metric"><span class="metric-val">{fmtNum(met.followers)}</span><span class="metric-label">Followers</span></div>
              <div class="metric"><span class="metric-val">{fmtNum(met.following)}</span><span class="metric-label">Following</span></div>
              <div class="metric"><span class="metric-val">{fmtNum(met.tweets_count)}</span><span class="metric-label">Tweets</span></div>
            </div>
          {/each}

          <!-- Top posts -->
          {#await fetchPerformance(acc.id, 30) then perf}
            <div class="perf-summary">
              <div class="perf-row">
                <span>Posts (30d): <strong>{perf.total_posts}</strong></span>
                <span>Avg likes: <strong>{Math.round(perf.avg_likes)}</strong></span>
                <span>Avg RT: <strong>{Math.round(perf.avg_retweets)}</strong></span>
                <span>Avg impressions: <strong>{fmtNum(Math.round(perf.avg_impressions))}</strong></span>
              </div>
              {#if perf.top_posts?.length > 0}
                <div class="top-posts">
                  <div class="top-posts-title">Top Posts</div>
                  {#each perf.top_posts as tp}
                    <div class="top-post">
                      <div class="tp-content">{tp.content.slice(0, 100)}{tp.content.length > 100 ? '...' : ''}</div>
                      <div class="tp-metrics">
                        <span>❤ {tp.metrics_likes}</span>
                        <span>🔄 {tp.metrics_retweets}</span>
                        <span>👁 {fmtNum(tp.metrics_impressions)}</span>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {:catch}
            <div class="empty-list">Failed to load performance data.</div>
          {/await}

          <div class="acc-actions" style="margin-top:0.5rem">
            <button class="btn-sm btn-ghost" on:click={() => syncMetrics(acc.id)} disabled={syncing}>
              {syncing ? 'Syncing...' : '↻ Sync Metrics'}
            </button>
          </div>
        </Panel>
      {/each}
    </div>
  {/if}

</div>

{/if}

<!-- ── Post Editor Modal ──────────────────────────── -->
{#if showEditor}
  <div class="modal-bg" on:click|self={() => showEditor = false}>
    <div class="modal">
      <div class="modal-title">{editingPost ? 'Edit Post' : 'New Post'}</div>

      <div class="field">
        <label>Account</label>
        <select bind:value={editorAccountId}>
          {#each accounts as acc}
            <option value={acc.id}>@{acc.handle} ({acc.display_name || acc.handle})</option>
          {/each}
        </select>
      </div>

      <div class="field">
        <label>Type</label>
        <div class="radio-row">
          {#each ['tweet', 'reply', 'thread', 'quote'] as t}
            <label class="radio-label">
              <input type="radio" bind:group={editorType} value={t} />
              {t}
            </label>
          {/each}
        </div>
      </div>

      <div class="field">
        <label>Content <span class="char-count {charClass(editorContent.length)}">{editorContent.length}/280</span></label>
        <textarea
          bind:value={editorContent}
          rows="5"
          placeholder="What's happening in AI, open source, or Linux?"
          class="editor-textarea"
        ></textarea>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Status</label>
          <select bind:value={editorStatus}>
            <option value="draft">Draft</option>
            <option value="queued">Queue for review</option>
          </select>
        </div>
        <div class="field">
          <label>Schedule (optional)</label>
          <input type="datetime-local" bind:value={editorSchedule} />
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn-sm btn-ghost" on:click={() => showEditor = false}>Cancel</button>
        <button class="btn-sm btn-primary" on:click={savePost} disabled={saving || !editorContent.trim()}>
          {saving ? 'Saving...' : editingPost ? 'Update' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Account Editor Modal ───────────────────────── -->
{#if showAccountEditor}
  <div class="modal-bg" on:click|self={() => showAccountEditor = false}>
    <div class="modal">
      <div class="modal-title">{editingAccount ? 'Edit Account' : 'Add Account'}</div>

      <div class="field-row">
        <div class="field">
          <label>Handle (without @)</label>
          <input type="text" bind:value={accHandle} placeholder="username" />
        </div>
        <div class="field">
          <label>Display Name</label>
          <input type="text" bind:value={accDisplayName} placeholder="My Account" />
        </div>
      </div>

      <div class="field-separator">API Credentials (from developer.x.com)</div>

      <div class="field-row">
        <div class="field">
          <label>API Key (Consumer Key)</label>
          <input type="password" bind:value={accApiKey} placeholder="xxxxxx" />
        </div>
        <div class="field">
          <label>API Secret (Consumer Secret)</label>
          <input type="password" bind:value={accApiSecret} placeholder="xxxxxx" />
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Access Token</label>
          <input type="password" bind:value={accAccessToken} placeholder="xxxxxx" />
        </div>
        <div class="field">
          <label>Access Token Secret</label>
          <input type="password" bind:value={accAccessSecret} placeholder="xxxxxx" />
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn-sm btn-ghost" on:click={() => showAccountEditor = false}>Cancel</button>
        <button class="btn-sm btn-primary" on:click={saveAccount} disabled={saving || !accHandle.trim()}>
          {saving ? 'Saving...' : editingAccount ? 'Update' : 'Add Account'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Layout ─────────────────────────────────── */
  .header-actions { display: flex; gap: 0.5rem; }

  .tab-row {
    display: flex; gap: 0.25rem; padding: 0 1rem; margin-bottom: 0.5rem;
  }
  .tab-btn {
    padding: 0.4rem 0.8rem; border: 1px solid var(--border); border-radius: 6px;
    background: transparent; color: var(--text-2); font-size: 0.8rem; cursor: pointer;
    transition: all 0.15s;
  }
  .tab-btn:hover { background: var(--bg-2); }
  .tab-btn.active { background: var(--bg-2); color: var(--text-1); border-color: var(--blue); }

  .x-layout {
    display: grid; grid-template-columns: 1fr 340px; gap: 0.75rem;
    padding: 0 1rem; min-height: 50vh;
  }
  .x-list { display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto; max-height: 70vh; }
  .x-full { grid-column: 1 / -1; }
  .x-detail { display: flex; flex-direction: column; gap: 0.75rem; }

  .list-toolbar { display: flex; gap: 0.5rem; padding: 0.25rem 0; }

  /* ── Post Card ──────────────────────────────── */
  .post-card {
    padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 8px;
    cursor: pointer; transition: all 0.15s;
  }
  .post-card:hover { background: var(--bg-2); }
  .post-card.selected { border-color: var(--blue); background: var(--bg-2); }

  .post-top { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem; }
  .post-handle { font-weight: 600; font-size: 0.8rem; color: var(--blue); }
  .post-chars { font-size: 0.7rem; color: var(--text-3); margin-left: auto; }
  .post-chars.over { color: var(--red); font-weight: 600; }
  .post-content { font-size: 0.85rem; line-height: 1.35; color: var(--text-1); margin-bottom: 0.3rem; }
  .post-meta { display: flex; gap: 0.5rem; flex-wrap: wrap; font-size: 0.7rem; color: var(--text-3); }
  .meta-tag { display: inline-flex; gap: 0.15rem; }
  .meta-time { margin-left: auto; }

  /* ── Detail Panel ───────────────────────────── */
  .detail-badges { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
  .detail-content {
    font-size: 0.95rem; line-height: 1.5; white-space: pre-wrap;
    padding: 0.75rem; background: var(--bg-1); border-radius: 6px; border: 1px solid var(--border);
  }
  .detail-chars { font-size: 0.75rem; margin-top: 0.25rem; }
  .detail-chars.ok { color: var(--green); }
  .detail-chars.warn { color: var(--gold); }
  .detail-chars.over { color: var(--red); }
  .detail-row { font-size: 0.8rem; color: var(--text-2); margin-top: 0.25rem; }
  .detail-row a { color: var(--blue); text-decoration: none; }
  .detail-error { color: var(--red); font-size: 0.8rem; margin-top: 0.5rem; padding: 0.5rem; background: rgba(var(--red-rgb, 220,50,50), 0.1); border-radius: 4px; }
  .detail-actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap; }

  .empty-detail { text-align: center; padding: 2rem; color: var(--text-3); }
  .empty-icon { font-size: 2.5rem; margin-bottom: 0.5rem; }
  .empty-list { color: var(--text-3); font-size: 0.85rem; padding: 1rem; text-align: center; }

  /* ── Metrics ────────────────────────────────── */
  .metrics-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .metrics-grid.big { grid-template-columns: repeat(3, 1fr); }
  .metric { text-align: center; padding: 0.5rem; background: var(--bg-1); border-radius: 6px; }
  .metric-val { display: block; font-size: 1.2rem; font-weight: 700; color: var(--text-1); }
  .metric-label { font-size: 0.7rem; color: var(--text-3); }

  /* ── Mention Card ───────────────────────────── */
  .mention-card {
    padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 8px;
  }
  .mention-top { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.2rem; }
  .mention-author { font-weight: 600; font-size: 0.85rem; color: var(--blue); }
  .mention-name { font-size: 0.8rem; color: var(--text-2); }
  .mention-content { font-size: 0.85rem; line-height: 1.35; color: var(--text-1); margin-bottom: 0.2rem; }
  .mention-meta { display: flex; gap: 1rem; font-size: 0.7rem; color: var(--text-3); }

  /* ── Account Card ───────────────────────────── */
  .account-card {
    padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px;
  }
  .acc-top { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.3rem; }
  .acc-handle { font-weight: 700; font-size: 1rem; color: var(--text-1); }
  .acc-name { font-size: 0.85rem; color: var(--text-2); }
  .acc-creds { font-size: 0.75rem; color: var(--text-3); display: flex; gap: 1rem; margin-bottom: 0.3rem; }
  .acc-metrics { font-size: 0.8rem; display: flex; gap: 1rem; color: var(--text-2); margin-bottom: 0.3rem; }
  .acc-actions { display: flex; gap: 0.5rem; }

  /* ── Scheduled ──────────────────────────────── */
  .sched-item {
    display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0;
    border-bottom: 1px solid var(--border); cursor: pointer; font-size: 0.8rem;
  }
  .sched-item:last-child { border-bottom: none; }
  .sched-time { font-size: 0.75rem; color: var(--gold); white-space: nowrap; }
  .sched-content { flex: 1; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── Breakdown ──────────────────────────────── */
  .breakdown-row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .breakdown-item { display: flex; align-items: center; gap: 0.3rem; font-size: 0.8rem; }
  .breakdown-dot { width: 8px; height: 8px; border-radius: 50%; }
  .breakdown-label { color: var(--text-2); }
  .breakdown-count { font-weight: 600; color: var(--text-1); }

  /* ── Performance ────────────────────────────── */
  .perf-summary { margin-top: 0.5rem; }
  .perf-row { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.8rem; color: var(--text-2); }
  .top-posts { margin-top: 0.5rem; }
  .top-posts-title { font-size: 0.75rem; font-weight: 600; color: var(--text-2); margin-bottom: 0.3rem; }
  .top-post { padding: 0.3rem 0; border-bottom: 1px solid var(--border); }
  .top-post:last-child { border-bottom: none; }
  .tp-content { font-size: 0.8rem; color: var(--text-1); }
  .tp-metrics { display: flex; gap: 0.75rem; font-size: 0.7rem; color: var(--text-3); margin-top: 0.15rem; }

  /* ── Modal ──────────────────────────────────── */
  .modal-bg {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100;
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: var(--bg-1); border: 1px solid var(--border); border-radius: 12px;
    padding: 1.25rem; width: 520px; max-width: 95vw; max-height: 90vh; overflow-y: auto;
  }
  .modal-title { font-size: 1rem; font-weight: 700; margin-bottom: 0.75rem; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }

  .field { margin-bottom: 0.75rem; }
  .field label { display: block; font-size: 0.75rem; color: var(--text-2); margin-bottom: 0.25rem; }
  .field input, .field select, .field textarea {
    width: 100%; padding: 0.5rem; background: var(--bg-0); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text-1); font-size: 0.85rem; font-family: inherit;
  }
  .field textarea { resize: vertical; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
  .field-separator {
    font-size: 0.75rem; font-weight: 600; color: var(--text-3); margin: 0.5rem 0;
    padding-top: 0.5rem; border-top: 1px solid var(--border);
  }

  .radio-row { display: flex; gap: 0.75rem; }
  .radio-label { display: flex; align-items: center; gap: 0.25rem; font-size: 0.8rem; color: var(--text-2); cursor: pointer; }

  .char-count { float: right; font-size: 0.7rem; }
  .char-count.ok { color: var(--green); }
  .char-count.warn { color: var(--gold); }
  .char-count.over { color: var(--red); }

  .editor-textarea { min-height: 100px; }

  /* ── Buttons ────────────────────────────────── */
  .btn-sm {
    padding: 0.35rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg-2); color: var(--text-1); font-size: 0.8rem; cursor: pointer;
    transition: all 0.15s;
  }
  .btn-sm:hover { background: var(--bg-3); }
  .btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--blue); color: #fff; border-color: var(--blue); }
  .btn-primary:hover { filter: brightness(1.1); }
  .btn-ghost { background: transparent; border-color: transparent; }
  .btn-ghost:hover { background: var(--bg-2); }
  .btn-danger { color: var(--red); border-color: var(--red); background: transparent; }
  .btn-danger:hover { background: rgba(220,50,50,0.1); }
</style>

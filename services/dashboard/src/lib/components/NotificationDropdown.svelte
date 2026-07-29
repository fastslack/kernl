<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { miniMd } from '$lib/mini-md.js';
  import type { DashboardNotification } from '$lib/stores.js';
  import { timeAgo } from '$lib/utils.js';

  export let open = false;
  export let notifications: DashboardNotification[] = [];
  export let unreadCount = 0;

  const dispatch = createEventDispatcher<{
    toggle: void;
    markRead: { id: string };
    markAllRead: void;
    viewAll: void;
  }>();

  /** Prepare notification body for rendering: split bullet lines, convert emoji codes */
  function renderNotifBody(body: string): string {
    let s = body;
    s = s.replace(/:warning:/g, '\u26A0\uFE0F');
    s = s.replace(/:bell:/g, '\uD83D\uDD14');
    s = s.replace(/:check:/g, '\u2705');
    s = s.replace(/:x:/g, '\u274C');
    s = s.replace(/\s*•\s*/g, '\n- ');
    return miniMd(s);
  }

</script>

<div class="notif-wrapper">
  <button class="header-icon-btn" on:click={() => dispatch('toggle')} title="Notifications">
    🔔
    {#if unreadCount > 0}
      <span class="header-icon-badge hb-visible">{unreadCount}</span>
    {/if}
  </button>
  {#if open}
    <div class="notif-panel">
      <div class="notif-header">
        <span class="notif-title">Notifications</span>
        {#if unreadCount > 0}
          <button class="notif-mark-all" on:click={() => dispatch('markAllRead')}>Mark all read</button>
        {/if}
        <button class="notif-mark-all" on:click={() => dispatch('viewAll')}>View All</button>
      </div>
      <div class="notif-list">
        {#if notifications.length === 0}
          <div class="notif-empty">No notifications</div>
        {:else}
          {#each notifications as n (n.id)}
            <div
              class="notif-item"
              class:notif-unread={!n.read}
              class:notif-high={n.priority === 'high'}
              on:click={() => { if (!n.read) dispatch('markRead', { id: n.id }); }}
              role="button"
              tabindex="0"
              on:keypress={() => { if (!n.read) dispatch('markRead', { id: n.id }); }}
            >
              <div class="notif-item-header">
                <span class="notif-item-title">
                  {#if n.priority === 'high'}🚨{/if}
                  {n.title}
                </span>
                <span class="notif-item-time">{timeAgo(n.created_at)}</span>
              </div>
              {#if n.body}
                <div class="notif-item-body">{@html renderNotifBody(n.body)}</div>
              {/if}
              {#if n.source}
                <div class="notif-item-source">{n.source}</div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

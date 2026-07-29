<script lang="ts">
  import { TL_COLORS } from '$lib/constants.js';
  import Empty from './Empty.svelte';

  export let open = false;
  export let date = '';
  export let events: any[] = [];
  export let onClose: () => void = () => {};
  // Management callbacks (no-ops by default → read-only fallback).
  export let onCreate: (payload: { type: string; title: string; time: string }) => void = () => {};
  export let onComplete: (ev: any) => void = () => {};
  export let onReschedule: (ev: any, targetDate: string) => void = () => {};
  export let onRename: (ev: any, title: string) => void = () => {};
  export let onDelete: (ev: any) => void = () => {};
  export let busy = false;

  const todayStr = new Date().toISOString().split('T')[0];
  // Only these chip types support inline management.
  const MANAGEABLE = new Set(['task', 'reminder', 'event']);

  $: isToday = date === todayStr;

  // Per-row UI state, keyed by event id.
  let renamingId = '';
  let renameValue = '';
  let reschedulingId = '';
  let rescheduleValue = '';

  // Add-form state.
  let showAdd = false;
  let newType = 'task';
  let newTitle = '';
  let newTime = '';

  function formatDateLabel(d: string): string {
    if (!d) return '';
    const dt = new Date(d + 'T12:00:00Z');
    return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  function startRename(ev: any) {
    renamingId = ev.id; renameValue = ev.title ?? ''; reschedulingId = '';
  }
  function commitRename(ev: any) {
    const v = renameValue.trim();
    if (v && v !== ev.title) onRename(ev, v);
    renamingId = '';
  }
  function startReschedule(ev: any) {
    reschedulingId = ev.id; rescheduleValue = date; renamingId = '';
  }
  function commitReschedule(ev: any) {
    if (rescheduleValue && rescheduleValue !== date) onReschedule(ev, rescheduleValue);
    reschedulingId = '';
  }
  function submitAdd() {
    const t = newTitle.trim();
    if (!t) return;
    onCreate({ type: newType, title: t, time: newTime });
    newTitle = ''; newTime = ''; showAdd = false;
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <div class="day-modal-overlay" on:click={onClose} on:keypress={() => {}} role="dialog" aria-label="Day details">
    <div class="day-modal" on:click|stopPropagation={() => {}} on:keypress={() => {}} role="document">
      <div class="day-modal-header">
        <div class="day-modal-title">
          {formatDateLabel(date)}
          {#if isToday}<span class="day-modal-today">Today</span>{/if}
        </div>
        <button class="day-modal-close" on:click={onClose}>x</button>
      </div>
      <div class="day-modal-body">
        {#if !events.length}
          <Empty message="No events" />
        {:else}
          {#each events as ev (ev.id)}
            <div class="tl-ev">
              <div class="tl-ev-dot" style="background:{ev.color ?? TL_COLORS[ev.type] ?? 'var(--text-3)'}"></div>
              <div class="tl-ev-info">
                {#if renamingId === ev.id}
                  <input
                    class="dm-input"
                    bind:value={renameValue}
                    on:keydown={(e) => e.key === 'Enter' && commitRename(ev)}
                    on:blur={() => commitRename(ev)}
                    autofocus
                  />
                {:else}
                  <div class="tl-ev-title">{ev.title}</div>
                  <div class="tl-ev-meta">{[ev.time, ev.type, ev.extra].filter(Boolean).join(' · ')}</div>
                {/if}
                {#if reschedulingId === ev.id}
                  <div class="dm-reschedule">
                    <input type="date" class="dm-input" bind:value={rescheduleValue} />
                    <button class="dm-btn" on:click={() => commitReschedule(ev)} disabled={busy}>Move</button>
                    <button class="dm-btn ghost" on:click={() => (reschedulingId = '')}>Cancel</button>
                  </div>
                {/if}
              </div>
              {#if MANAGEABLE.has(ev.type)}
                <div class="dm-actions">
                  <button class="dm-icon" title="Complete" on:click={() => onComplete(ev)} disabled={busy}>✓</button>
                  <button class="dm-icon" title="Rename" on:click={() => startRename(ev)} disabled={busy}>✎</button>
                  <button class="dm-icon" title="Reschedule" on:click={() => startReschedule(ev)} disabled={busy}>🗓</button>
                  <button class="dm-icon danger" title="Delete" on:click={() => onDelete(ev)} disabled={busy}>🗑</button>
                </div>
              {/if}
            </div>
          {/each}
        {/if}

        <!-- Add new item -->
        {#if showAdd}
          <div class="dm-add">
            <div class="dm-add-row">
              <select bind:value={newType} class="dm-input">
                <option value="task">Task</option>
                <option value="event">Event</option>
                <option value="reminder">Reminder</option>
              </select>
              <input type="time" class="dm-input dm-time" bind:value={newTime} title="Time (optional)" />
            </div>
            <input
              class="dm-input"
              placeholder="Title…"
              bind:value={newTitle}
              on:keydown={(e) => e.key === 'Enter' && submitAdd()}
            />
            <div class="dm-add-row">
              <button class="dm-btn" on:click={submitAdd} disabled={busy || !newTitle.trim()}>Add</button>
              <button class="dm-btn ghost" on:click={() => (showAdd = false)}>Cancel</button>
            </div>
          </div>
        {:else}
          <button class="dm-add-toggle" on:click={() => (showAdd = true)} disabled={busy}>+ Add to this day</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .day-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .day-modal {
    background: var(--surface-1, #1e2030);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    width: 90%;
    max-width: 460px;
    max-height: 80vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.2s ease-out;
  }
  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
  .day-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2, #252837);
  }
  .day-modal-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-1);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .day-modal-today {
    font-size: 10px;
    font-weight: 600;
    color: var(--teal);
    background: rgba(61, 214, 200, 0.15);
    padding: 3px 8px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .day-modal-close {
    width: 28px;
    height: 28px;
    border: none;
    background: var(--bg-1);
    border-radius: 6px;
    color: var(--text-3);
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }
  .day-modal-close:hover {
    background: var(--bg-3);
    color: var(--text-1);
  }
  .day-modal-body {
    padding: 16px 20px;
    overflow-y: auto;
    max-height: 60vh;
    background: var(--surface-1, #1e2030);
  }
  .day-modal-body .tl-ev {
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }
  .day-modal-body .tl-ev:last-of-type {
    border-bottom: none;
  }
  .day-modal-body .tl-ev-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 4px;
  }
  .day-modal-body .tl-ev-info {
    flex: 1;
    min-width: 0;
  }
  .day-modal-body .tl-ev-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .day-modal-body .tl-ev-meta {
    font-size: 11px;
    color: var(--text-3);
    margin-top: 2px;
  }
  .tl-ev {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .dm-actions {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }
  .dm-icon {
    border: none;
    background: transparent;
    color: var(--text-3);
    font-size: 13px;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.12s;
  }
  .dm-icon:hover { background: var(--bg-3); color: var(--text-1); }
  .dm-icon.danger:hover { color: var(--red, #f04770); }
  .dm-icon:disabled { opacity: 0.4; cursor: not-allowed; }
  .dm-input {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-1);
    font-size: 12px;
    padding: 6px 8px;
  }
  .dm-time { width: 110px; }
  .dm-reschedule {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    align-items: center;
  }
  .dm-btn {
    border: 1px solid var(--border);
    background: var(--accent, #5b9bf7);
    color: #fff;
    border-radius: 6px;
    font-size: 12px;
    padding: 6px 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .dm-btn.ghost { background: transparent; color: var(--text-2); }
  .dm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .dm-add {
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dm-add-row { display: flex; gap: 8px; }
  .dm-add-toggle {
    margin-top: 14px;
    width: 100%;
    border: 1px dashed var(--border);
    background: transparent;
    color: var(--text-2);
    border-radius: 8px;
    padding: 10px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.12s;
  }
  .dm-add-toggle:hover { background: var(--bg-3); color: var(--text-1); }
  .dm-add-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
</style>

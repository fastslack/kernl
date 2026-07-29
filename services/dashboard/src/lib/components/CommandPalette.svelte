<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let open = false;
  export let commands: Array<{ label: string; action: () => void }> = [];

  const dispatch = createEventDispatcher<{
    close: void;
    select: { command: { label: string; action: () => void } };
  }>();

  let query = '';
  let cmdInput: HTMLInputElement;
  let selectedIndex = 0;

  $: filtered = query
    ? commands.filter(c => c.label.toLowerCase().includes(query.toLowerCase()))
    : commands;

  // Reset selection when filter changes
  $: if (filtered) selectedIndex = 0;

  // Focus input when opened
  $: if (open) {
    query = '';
    selectedIndex = 0;
    setTimeout(() => cmdInput?.focus(), 50);
  }

  function close() {
    dispatch('close');
  }

  function selectItem(cmd: { label: string; action: () => void }) {
    dispatch('select', { command: cmd });
    close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) selectItem(filtered[selectedIndex]);
      return;
    }
  }
</script>

<div
  class="cmd-overlay"
  class:open
  on:click|self={close}
  on:keydown={handleKeydown}
  role="dialog"
  aria-label="Command palette"
>
  <div class="cmd-modal">
    <input
      bind:this={cmdInput}
      bind:value={query}
      class="cmd-input"
      placeholder="Search views or actions..."
      autocomplete="off"
      on:keydown={handleKeydown}
    />
    <div class="cmd-results">
      {#each filtered as cmd, i}
        <div
          class="cmd-item"
          class:cmd-item-selected={i === selectedIndex}
          on:click={() => selectItem(cmd)}
          role="button"
          tabindex="0"
          on:keypress={() => selectItem(cmd)}
        >
          <span class="cmd-item-icon">→</span>
          <span>{cmd.label}</span>
        </div>
      {/each}
    </div>
  </div>
</div>

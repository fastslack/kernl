<script lang="ts">
  /** Small switch toggle. `bind:checked` from the parent works: clicking mutates the prop. */
  export let checked = false;
  export let disabled = false;
  export let id = '';
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  {id}
  class="tg"
  class:on={checked}
  {disabled}
  on:click={() => { checked = !checked; }}
  on:click
>
  <span class="knob" />
</button>

<style>
  .tg {
    position: relative; width: 32px; height: 18px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--surface-3);
    cursor: pointer; padding: 0; transition: background 0.15s, border-color 0.15s;
    flex-shrink: 0;
  }
  .tg:disabled { opacity: 0.4; cursor: default; }
  .tg.on { background: var(--teal); border-color: var(--teal); }
  .knob {
    position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
    border-radius: 50%; background: var(--text-1); transition: transform 0.15s;
  }
  .tg.on .knob { transform: translateX(14px); background: var(--bg); }
</style>

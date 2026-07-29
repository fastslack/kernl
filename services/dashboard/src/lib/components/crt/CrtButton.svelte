<!--
  CrtButton — vim-flavored button. The `:w` / `:q` aesthetic.

  Variants:
    primary  — solid amber-on-dark, used for confirm actions ("post", :w)
    ghost    — transparent with dim border, secondary actions (:q)
    dim      — text-only, lowest emphasis
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let variant: 'primary' | 'ghost' | 'dim' = 'ghost';
  export let disabled = false;
  export let title: string | undefined = undefined;
  export let type: 'button' | 'submit' = 'button';

  const dispatch = createEventDispatcher<{ click: MouseEvent }>();
</script>

<button
  {type}
  {title}
  {disabled}
  class="crt-btn variant-{variant}"
  on:click={(e) => dispatch('click', e)}
>
  <slot />
</button>

<style>
  .crt-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-1);
    padding: 3px 10px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    border-radius: 2px;
    line-height: 1.4;
    transition: border-color 0.1s, background 0.1s;
  }
  .crt-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .variant-primary {
    background: var(--surface-3);
    border-color: var(--gold);
    color: var(--gold);
  }
  .variant-primary:hover:not(:disabled) {
    background: var(--gold);
    color: var(--bg);
  }

  .variant-ghost {
    background: transparent;
    color: var(--text-1);
  }
  .variant-ghost:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border-h);
  }

  .variant-dim {
    background: none;
    border: none;
    color: var(--text-2);
    padding: 2px 6px;
  }
  .variant-dim:hover:not(:disabled) {
    color: var(--text-1);
  }
</style>

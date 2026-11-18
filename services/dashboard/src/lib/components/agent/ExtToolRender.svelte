<script lang="ts">
  // One step of an extension's tool, drawn by the extension's own renderer (lib/tool-renderers.ts). Until it loads,
  // or when it fails, nothing is drawn and the plain text around it stays the source of truth.
  import { onDestroy } from 'svelte';
  import type { ToolRenderHandle, ToolRenderInput } from '$shared/tool-renderer.js';
  import { loadToolRenderer, toolRendererContext } from '$lib/tool-renderer-loader.js';
  import type { ExtToolRendererInfo } from '$lib/tool-renderers.js';

  export let info: ExtToolRendererInfo | undefined;
  export let input: ToolRenderInput;

  let target: HTMLDivElement;
  let handle: ToolRenderHandle | null = null;
  let failed = false;
  let mountedKey = '';

  async function mount(key: string) {
    if (!info) return;
    try {
      const render = await loadToolRenderer(info);
      if (key !== mountedKey || !target) return;
      handle?.destroy();
      handle = render(target, input, toolRendererContext(info!) as never) || null;
    } catch (err) {
      failed = true;
      console.warn('[tool-renderer]', info?.slug, err);
    }
  }

  $: key = info ? `${info.slug}/${info.entry}@${info.version}` : '';
  $: if (target && key && key !== mountedKey) { mountedKey = key; void mount(key); }
  $: if (handle?.update) { try { handle.update(input); } catch (err) { console.warn('[tool-renderer] update', err); } }

  onDestroy(() => { try { handle?.destroy(); } catch { /* gone */ } handle = null; });
</script>

{#if !failed}<div class="ext-tool-render" bind:this={target}></div>{/if}

<style>
  .ext-tool-render:empty { display: none; }
  .ext-tool-render { margin: 4px 0 2px 18px; }
</style>

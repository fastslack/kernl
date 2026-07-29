<script lang="ts">
  export let title: string = '';
  export let dotColor: string = '';
  export let cls: string = '';
  export let style: string = '';
</script>

<div class="panel {cls}" {style}>
  {#if title}
    <div class="panel-title">
      {#if dotColor}<span class="dot" style="background:{dotColor}"></span>{/if}
      {title}
    </div>
  {/if}
  <slot />
</div>

<script lang="ts">
  export let title: string;
  export let sub: string = '';
</script>

<div class="view-header anim">
  <div>
    <div class="view-title">{title}</div>
    {#if sub}<div class="view-sub">{sub}</div>{/if}
  </div>
  <slot />
</div>

<script lang="ts">
  import Badge from './Badge.svelte';
  export let time: string = '';
  export let title: string;
  export let badge: string = '';
  export let isOverdue: boolean = false;
</script>

<div class="agenda-item">
  <span class="agenda-time" style={isOverdue ? 'color:var(--red)' : ''}>{time}</span>
  <div class="agenda-content">
    <div class="agenda-title">{title}</div>
    {#if badge}
      <div class="agenda-meta">
        <Badge text={badge} />
      </div>
    {/if}
  </div>
</div>

<script lang="ts">
  export let label: string;
  export let value: string | number;
  export let sub: string = '';
  export let accent: string = ''; // CSS var name like '--gold'
  export let color: string = '';  // CSS color like 'var(--gold)'
</script>

<div class="kpi">
  <div class="kpi-label">{label}</div>
  <div class="kpi-value" style={color ? `color:${color}` : ''}>{value}</div>
  {#if sub}<div class="kpi-sub">{sub}</div>{/if}
  {#if accent}<div class="kpi-accent" style="background:var({accent})"></div>{/if}
</div>

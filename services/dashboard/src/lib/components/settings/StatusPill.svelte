<script lang="ts">
  /** Compact status pill: ok / warn / error / neutral */
  export let status: 'ok' | 'warn' | 'error' | 'neutral' = 'neutral';
  export let label = '';
</script>

<span class="pill {status}"><span class="dot" />{label}</span>

<style>
  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 8px; border-radius: 999px;
    font: 600 9px var(--font-mono); letter-spacing: 0.4px; text-transform: uppercase;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2);
    white-space: nowrap;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); flex-shrink: 0; }
  .pill.ok { border-color: rgba(34,197,94,0.35); color: #4ade80; }
  .pill.ok .dot { background: #22c55e; }
  .pill.warn { border-color: rgba(245,158,11,0.35); color: #fbbf24; }
  .pill.warn .dot { background: #f59e0b; }
  .pill.error { border-color: rgba(239,68,68,0.35); color: #f87171; }
  .pill.error .dot { background: #ef4444; }
</style>

<script context="module" lang="ts">
  /** Permission prompt currently waiting on the user. Only one at a time —
   *  the SDK serializes its canUseTool calls so we never have two pending. */
  export type PendingPermission = {
    request_id: string;
    tool_name: string;
    input: Record<string, unknown>;
  };
</script>

<script lang="ts">
  /** The page decides when a prompt is showing and answers the kernel. */
  import { formatToolInput } from '$lib/tool-presentation.js';

  export let permission: PendingPermission;
  export let onRespond: (allow: boolean) => void = () => {};
</script>

<div class="cx-perm-scrim" role="presentation"></div>
<div class="cx-perm-modal" role="dialog" aria-modal="true">
  <div class="cx-perm-head">
    <span class="cx-perm-title">Tool permission</span>
    <span class="cx-perm-tool">{permission.tool_name}</span>
  </div>
  <div class="cx-perm-body">
    <div class="cx-perm-label">Input</div>
    <pre class="cx-perm-input">{formatToolInput(permission.input)}</pre>
  </div>
  <div class="cx-perm-actions">
    <button class="cx-perm-deny" on:click={() => onRespond(false)}>Deny</button>
    <button class="cx-perm-allow" on:click={() => onRespond(true)}>Allow</button>
  </div>
</div>

<style>
  .cx-perm-scrim {
    position: fixed; inset: 0; z-index: 998;
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(2px);
  }
  .cx-perm-modal {
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    z-index: 999;
    width: min(560px, 92vw);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 18px 50px rgba(0,0,0,0.6);
    overflow: hidden;
  }
  .cx-perm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .cx-perm-title { font-weight: 600; color: var(--text-1); }
  .cx-perm-tool {
    background: var(--gold);
    color: #1a1a1a;
    padding: 2px 8px;
    border-radius: 4px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    font-weight: 600;
  }
  .cx-perm-body { padding: 12px 16px; }
  .cx-perm-label {
    font-size: 11px;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin-bottom: 6px;
  }
  .cx-perm-input {
    margin: 0;
    padding: 10px;
    background: rgba(0,0,0,0.3);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--text-2);
    max-height: 280px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cx-perm-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.02);
  }
  .cx-perm-deny,
  .cx-perm-allow {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-1);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 600;
    font-size: 12px;
  }
  .cx-perm-deny:hover { border-color: #ff8080; color: #ff8080; }
  .cx-perm-allow {
    background: var(--gold);
    color: #1a1a1a;
    border-color: var(--gold);
  }
  .cx-perm-allow:hover { filter: brightness(1.1); }
</style>

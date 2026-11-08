<script lang="ts">
  /**
   * Hand an Aprobaciones item to an office: pick the office (the project's own first) and add a note. Its lead gets
   * a letter with the item, the send error if there was one, and the note; the item leaves the queue.
   */
  export let own: Array<{ id: string; name: string }> = [];
  export let rest: Array<{ id: string; name: string }> = [];
  export let flow = '';
  export let note = '';
  export let busy = false;
  export let onSubmit: () => void = () => {};
  export let onCancel: () => void = () => {};
</script>

<form class="choice" on:submit|preventDefault={onSubmit}>
  <label for="handoff-office">¿A qué oficina se lo pasás? Le llega a su líder con el pedido completo y el error.</label>
  <select id="handoff-office" bind:value={flow}>
    {#if own.length}
      <optgroup label="Oficinas del proyecto">
        {#each own as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
      </optgroup>
    {/if}
    {#if rest.length}
      <optgroup label={own.length ? 'Otras oficinas' : 'Oficinas'}>
        {#each rest as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
      </optgroup>
    {/if}
  </select>
  <input bind:value={note} placeholder="Qué querés que hagan (opcional): «revisá el token de GitLab», «hacelo vos»…" />
  <div class="actions">
    <button type="button" class="btn" on:click={onCancel}>Volver</button>
    <button class="btn primary" disabled={busy || !flow}>{busy ? 'Pasando…' : 'Pasar a la oficina'}</button>
  </div>
</form>

<style>
  .choice { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; background: var(--surface-2); }
  label { font-size: 14px; font-weight: 600; color: var(--text-1); }
  select, input { font: inherit; font-size: 14px; color: var(--text-1); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
  .actions { display: flex; gap: 10px; align-items: center; justify-content: flex-end; }
  /* Same buttons as the page's (its styles are scoped to it). */
  .btn { display: inline-flex; align-items: center; gap: 8px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1); border-radius: var(--radius-sm); padding: 8px 14px; cursor: pointer; font: inherit; font-size: 14px; min-height: 40px; }
  .btn:hover:not(:disabled) { background: var(--surface-3); }
  .btn.primary { background: linear-gradient(135deg, var(--ob-go), var(--ob-go-2)); color: #04140C; border-color: transparent; font-weight: 700; }
  .btn:disabled { opacity: 0.45; cursor: default; }
</style>

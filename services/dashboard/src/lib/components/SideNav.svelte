<script context="module" lang="ts">
  export interface SideNavItem {
    id: string;
    label: string;
    icon?: string;
    /** Etiqueta de separador a dibujar ENCIMA de este item. */
    divider?: string;
  }
</script>

<script lang="ts">
  /**
   * Rail lateral compartido por /settings y las páginas de Sistema.
   *
   * La búsqueda no vive acá: Settings indexa claves del catálogo, no items de
   * navegación, así que inyecta su buscador por el slot `top`. El rail de
   * Sistema tiene seis items y no necesita ninguno.
   *
   * Los items son botones y no enlaces a propósito, igual que el tab rail del
   * header: la ruta de un item puede venir de un `path` de manifiesto que el
   * shell resuelve recién al hacer click.
   */
  export let items: SideNavItem[] = [];
  export let active = '';
  export let onSelect: (id: string) => void;
  export let ariaLabel = 'Sections';
</script>

<nav class="sidenav" aria-label={ariaLabel}>
  <slot name="top" />
  {#each items as item (item.id)}
    {#if item.divider}
      <div class="sidenav-divider">{item.divider}</div>
    {/if}
    <button
      class="sidenav-item"
      class:active={active === item.id}
      aria-current={active === item.id ? 'page' : undefined}
      on:click={() => onSelect(item.id)}
    >
      {#if item.icon}<span class="sidenav-icon">{item.icon}</span>{/if}
      {item.label}
    </button>
  {/each}
</nav>

<style>
  .sidenav {
    display: flex; flex-direction: column; gap: 2px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    padding: 8px; height: fit-content; max-height: 100%; overflow-y: auto;
    scrollbar-width: thin;
  }
  .sidenav-item {
    display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-radius: 6px;
    border: none; background: none; cursor: pointer; text-align: left; font-family: inherit;
    color: var(--text-2); transition: all 0.15s; width: 100%;
    font-size: 12px; font-weight: 600;
  }
  .sidenav-item:hover { background: var(--surface-2); }
  .sidenav-item.active { background: var(--surface-3); color: var(--text-1); }
  .sidenav-icon { font-size: 13px; flex-shrink: 0; }
  .sidenav-divider {
    font: 700 8px var(--font-mono); text-transform: uppercase; letter-spacing: 1px;
    color: var(--text-3); margin: 8px 4px 4px; padding-top: 8px; border-top: 1px solid var(--border);
  }
  @media (max-width: 700px) {
    .sidenav { flex-direction: column; max-height: 220px; }
  }
</style>

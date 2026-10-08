<!-- services/dashboard/src/routes/+error.svelte -->
<script lang="ts">
  import { page } from '$app/stores';
  import { t } from '$lib/i18n/index.js';
  import { toast } from '$shared/feedback';
  $: notFound = $page.status === 404;
  $: detail = `${$page.status} ${$page.error?.message ?? ''}\n${$page.url.pathname}`;
  async function copy() {
    try { await navigator.clipboard.writeText(detail); toast.success($t('feedback.error.copied')); }
    catch { toast.info(detail); }
  }
</script>

<div class="err">
  <h1>{notFound ? $t('feedback.error.not_found') : $t('feedback.error.title')}</h1>
  {#if !notFound}<p class="code">{$page.status} · {$page.error?.message ?? ''}</p>{/if}
  <div class="acts">
    {#if !notFound}<button class="btn" on:click={() => location.reload()}>{$t('feedback.retry')}</button>{/if}
    <a class="btn ghost" href="/">{$t('feedback.error.home')}</a>
    {#if !notFound}<button class="btn ghost" on:click={copy}>{$t('feedback.error.report')}</button>{/if}
  </div>
  {#if notFound}<p class="hint">{$t('feedback.error.search_hint')}</p>{/if}
</div>

<style>
  .err { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; min-height: 60vh; padding: 24px; text-align: center; }
  h1 { margin: 0; font-size: 22px; color: var(--text-1); }
  .code { margin: 0; font-family: var(--font-mono); font-size: 12.5px; color: var(--text-3); }
  .acts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .btn { background: var(--teal); color: var(--bg); border: 0; border-radius: 6px; padding: 8px 16px; font-weight: 700; cursor: pointer; text-decoration: none; font-size: 13px; }
  .btn.ghost { background: none; border: 1px solid var(--border); color: var(--text-2); font-weight: 500; }
  .hint { margin: 0; font-size: 12.5px; color: var(--text-3); }
</style>

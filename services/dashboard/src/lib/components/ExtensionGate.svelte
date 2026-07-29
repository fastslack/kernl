<script lang="ts">
  import { locale } from '$lib/i18n';

  /**
   * Local dictionary on purpose — src/lib/i18n/{en,es}.ts are owned by
   * another workstream, so this component keeps its (tiny) copy here and
   * only consumes the shared `$locale` store for language selection.
   */
  const DICT: Record<string, { title: string; body: string; marketplace: string; home: string }> = {
    en: {
      title: 'Extension not available',
      body: 'This view belongs to an extension that is not installed or not active. Install or enable it from the Marketplace to unlock it.',
      marketplace: 'Go to Marketplace',
      home: 'Back to home',
    },
    es: {
      title: 'Extensión no disponible',
      body: 'This view belongs to an extension that is not installed or not active. Install or enable it from the Marketplace to unlock it.',
      marketplace: 'Ir al Marketplace',
      home: 'Back to home',
    },
  };

  $: t = DICT[$locale] ?? DICT.es;
</script>

<div class="gate-wrap">
  <div class="gate-panel">
    <div class="gate-icon" aria-hidden="true">🧩</div>
    <h2 class="gate-title">{t.title}</h2>
    <p class="gate-body">{t.body}</p>
    <div class="gate-actions">
      <a class="gate-btn gate-btn-primary" href="/extensions">{t.marketplace}</a>
      <a class="gate-btn" href="/">{t.home}</a>
    </div>
  </div>
</div>

<style>
  .gate-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
    padding: 24px;
  }
  .gate-panel {
    max-width: 440px;
    width: 100%;
    text-align: center;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius, 10px);
    padding: 40px 32px;
  }
  .gate-icon {
    font-size: 44px;
    line-height: 1;
    margin-bottom: 16px;
    opacity: 0.85;
  }
  .gate-title {
    color: var(--text-1);
    font-size: 17px;
    font-weight: 700;
    margin: 0 0 10px;
  }
  .gate-body {
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.55;
    margin: 0 0 24px;
  }
  .gate-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .gate-btn {
    display: inline-flex;
    align-items: center;
    padding: 8px 18px;
    border-radius: 8px;
    border: 1px solid var(--border);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .gate-btn:hover {
    color: var(--text-1);
    border-color: var(--teal);
  }
  .gate-btn-primary {
    background: var(--teal);
    border-color: var(--teal);
    color: var(--bg, #0a0c12);
  }
  .gate-btn-primary:hover {
    color: var(--bg, #0a0c12);
    filter: brightness(1.1);
  }
</style>

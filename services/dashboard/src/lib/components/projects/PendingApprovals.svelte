<script lang="ts">
  /*
    «Esperan tu OK» for one project: the drafts waiting in Aprobaciones, grouped
    by what they are and which office made them, with an example, what
    approving does (a mail goes out for real; a site change becomes a request
    to Development) and one button that opens Aprobaciones already filtered to
    that group. The bare number in the list ("17 por aprobar") said none of it.
  */
  import { goto } from '$app/navigation';
  import { apiFetchRaw } from '$lib/api.js';

  export let projectId: string;
  /** The project's offices, to name who made each draft. */
  export let offices: Array<{ flow_id: string; name: string }> = [];

  type Item = { id: string; channel: string; flow_id: string; payload: string | Record<string, unknown>; created_at: string };
  let items: Item[] = [];
  let loadedFor = '';

  async function load(id: string) {
    try {
      const r = await apiFetchRaw(`/api/outbox?status=draft&project_id=${encodeURIComponent(id)}`);
      if (!r.ok || id !== projectId) return;
      items = ((await r.json()).items ?? []) as Item[];
    } catch { /* the panel just stays hidden */ }
  }
  $: if (projectId && projectId !== loadedFor) { loadedFor = projectId; items = []; void load(projectId); }

  // What each kind is, in plain words, and what approving it does.
  const KIND: Record<string, { one: string; many: string; icon: string; does: string }> = {
    email: { one: 'mail', many: 'mails', icon: '✉', does: 'Al aprobarlos se envían de verdad al destinatario.' },
    email_campaign: { one: 'campaña de mail', many: 'campañas de mail', icon: '✉', does: 'Al aprobarla sale a toda la lista.' },
    web_change: { one: 'cambio en el sitio', many: 'cambios en el sitio', icon: '◇', does: 'Al aprobarlo se le pide a Desarrollo (abre un issue); el sitio no cambia solo.' },
    x_post: { one: 'post en X', many: 'posts en X', icon: '✦', does: 'Al aprobarlo se publica.' },
    linkedin_post: { one: 'post en LinkedIn', many: 'posts en LinkedIn', icon: '✦', does: 'Al aprobarlo se publica.' },
    tiktok_post: { one: 'video en TikTok', many: 'videos en TikTok', icon: '▶', does: 'Al aprobarlo se publica.' },
    reddit_post: { one: 'post en Reddit', many: 'posts en Reddit', icon: '✦', does: 'Al aprobarlo se publica.' },
    whatsapp: { one: 'mensaje de WhatsApp', many: 'mensajes de WhatsApp', icon: '✆', does: 'Al aprobarlo se envía.' },
  };
  const kind = (c: string) => KIND[c] ?? { one: c.replace(/_/g, ' '), many: c.replace(/_/g, ' '), icon: '•', does: 'Al aprobarlo sale.' };
  const office = (flow: string) => offices.find((o) => o.flow_id === flow)?.name ?? '';
  const parse = (p: Item['payload']): Record<string, any> => { if (typeof p !== 'string') return p ?? {}; try { return JSON.parse(p); } catch { return {}; } };
  const sample = (it: Item) => {
    const p = parse(it.payload);
    const to = Array.isArray(p.to) ? p.to[0] : p.to;
    const what = p.subject || p.title || (typeof p.text === 'string' ? p.text.slice(0, 80) : '');
    return [what && `«${what}»`, to && `a ${to}`].filter(Boolean).join(' ');
  };

  $: groups = Object.values(items.reduce((acc, it) => {
    const k = `${it.channel}|${it.flow_id}`;
    (acc[k] ??= { channel: it.channel, flow: it.flow_id, items: [] as Item[] }).items.push(it);
    return acc;
  }, {} as Record<string, { channel: string; flow: string; items: Item[] }>)).sort((a, b) => b.items.length - a.items.length);

  const review = (channel: string) => goto(`/outbox?project=${encodeURIComponent(projectId)}&channel=${encodeURIComponent(channel)}`);
</script>

{#if groups.length}
  <section class="pa" aria-label="Esperan tu aprobación">
    <header>
      <h3>Esperan tu OK <span class="n">{items.length}</span></h3>
      <p>Lo prepararon los agentes; nada sale sin que lo apruebes en Aprobaciones.</p>
    </header>
    <ul>
      {#each groups as g (g.channel + g.flow)}
        {@const k = kind(g.channel)}
        <li class="ch-{g.channel}">
          <span class="ic" aria-hidden="true">{k.icon}</span>
          <span class="what">
            <b>{g.items.length} {g.items.length === 1 ? k.one : k.many}{#if office(g.flow)}{' '}<i>de {office(g.flow)}</i>{/if}</b>
            <small title={sample(g.items[0])}>{sample(g.items[0])}{g.items.length > 1 ? ` y ${g.items.length - 1} más` : ''}</small>
            <small class="does">{k.does}</small>
          </span>
          <button class="go" on:click={() => review(g.channel)}>Revisar {g.items.length === 1 ? 'y aprobar' : 'uno por uno'} ›</button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .pa { margin: 0 0 8px; padding: 8px 10px; border-radius: 14px; border: 1px solid rgba(251, 191, 36, 0.45);
    background: linear-gradient(160deg, rgba(251, 191, 36, 0.1), transparent 70%); }
  header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  h3 { margin: 0; font-size: 14px; font-weight: 700; color: #fde68a; display: flex; align-items: center; gap: 8px; }
  .n { font-size: 12px; font-weight: 800; color: #1b1302; background: #fbbf24; border-radius: 999px; padding: 1px 8px; }
  header p { margin: 0; font-size: 12.5px; color: var(--text-2); }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  li { --c: #fbbf24; display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 10px;
    background: color-mix(in srgb, var(--c) 6%, var(--surface-1)); border: 1px solid color-mix(in srgb, var(--c) 30%, var(--border)); }
  li.ch-email, li.ch-email_campaign { --c: #f472b6; }
  li.ch-web_change { --c: #60a5fa; }
  .ic { flex: none; width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; font-size: 14px;
    color: color-mix(in srgb, var(--c) 80%, white); background: color-mix(in srgb, var(--c) 18%, transparent); border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); }
  .what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .what b { font-size: 13.5px; color: var(--text-1); }
  .what i { font-style: normal; font-weight: 500; color: var(--text-2); }
  .what small { font-size: 12px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .what .does { color: color-mix(in srgb, var(--c) 55%, var(--text-2)); }
  .go { flex: none; min-height: 34px; padding: 0 14px; border-radius: 10px; border: 0; cursor: pointer; font: 700 12.5px/1 var(--font-body);
    color: #120a02; background: var(--c); box-shadow: 0 8px 18px -12px var(--c); transition: transform 100ms, filter 150ms; }
  .go:hover { filter: brightness(1.08); }
  .go:active { transform: translateY(1px); }
  .go:focus-visible { outline: 2px solid var(--c); outline-offset: 2px; }
  @media (max-width: 720px) { li { flex-wrap: wrap; } .go { width: 100%; } }
</style>

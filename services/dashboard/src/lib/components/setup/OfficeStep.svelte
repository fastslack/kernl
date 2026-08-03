<script lang="ts">
  /**
   * "Hire your first team" — the step the wizard was missing.
   *
   * The old flow ended at a confirmation screen, which meant a new operator's
   * first sight of the product was an empty 3D floor with nothing to do. That is
   * the single worst moment this product can produce: everything that makes it
   * worth using is invisible until someone puts agents in the building.
   *
   * So this step does not ask for configuration. It offers three teams, hires
   * one, and then RUNS it — the operator reads a real answer from a real agent
   * before the wizard closes. Nothing here is a preview or a placeholder.
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '$lib/i18n/index.js';

  const dispatch = createEventDispatcher<{ done: void }>();

  interface Member { name: string; roleKey: string; prompt: string }
  interface Team { id: string; nameKey: string; color: string; tagKey: string; members: Member[] }

  /**
   * Deliberately small teams. Three agents read as a team you can hold in your
   * head; ten read as a configuration file. The prompts are short on purpose —
   * they are meant to be opened and edited, not admired.
   */
  const TEAMS: Team[] = [
    {
      id: 'ops',
      nameKey: 'setup.team_ops',
      color: '#22C55E',
      tagKey: 'setup.team_ops_tag',
      members: [
        { name: 'Iris', roleKey: 'setup.role_chief',
          prompt: 'You run the day. Each morning summarise what matters: what is due, what slipped, what needs a decision. Be brief and specific.' },
        { name: 'Tobias', roleKey: 'setup.role_triage',
          prompt: 'You read incoming mail and messages, sort what needs an answer from what does not, and draft replies for the ones that do.' },
        { name: 'Nadia', roleKey: 'setup.role_notes',
          prompt: 'You capture anything worth remembering and surface it later, unprompted, when it becomes relevant again.' },
      ],
    },
    {
      id: 'research',
      nameKey: 'setup.team_research',
      color: '#38BDF8',
      tagKey: 'setup.team_research_tag',
      members: [
        { name: 'Wren', roleKey: 'setup.role_editor',
          prompt: 'You decide what is worth reading today and hand back a short brief. No filler, no summaries of summaries.' },
        { name: 'Osgood', roleKey: 'setup.role_field',
          prompt: 'You dig into a question until you have sources, then report what you found and what you could not confirm.' },
        { name: 'Petra', roleKey: 'setup.role_archivist',
          prompt: 'You keep what was learned, tagged and findable, so the same question is never researched twice.' },
      ],
    },
    {
      id: 'workshop',
      nameKey: 'setup.team_workshop',
      color: '#F59E0B',
      tagKey: 'setup.team_workshop_tag',
      members: [
        { name: 'Hollis', roleKey: 'setup.role_foreman',
          prompt: 'You track the state of the work: what is broken, what is waiting, what is nearly done. You report before being asked.' },
        { name: 'Marek', roleKey: 'setup.role_builder',
          prompt: 'You make the small changes nobody schedules — a fix, a script, a cleanup — and explain what you did.' },
        { name: 'Sable', roleKey: 'setup.role_reviewer',
          prompt: 'You read changes critically and say plainly what would break. You do not approve out of politeness.' },
      ],
    },
  ];

  type Phase = 'choosing' | 'hiring' | 'proving' | 'ready' | 'failed';

  let phase: Phase = 'choosing';
  let picked: Team | null = null;
  /** Which members have been created so far — drives the staggered reveal. */
  let hired = 0;
  let firstAnswer = '';
  let error = '';

  const H = { 'Content-Type': 'application/json' };

  async function call(url: string, body?: unknown): Promise<any> {
    const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: H, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  }

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function hire(team: Team): Promise<void> {
    picked = team;
    phase = 'hiring';
    hired = 0;
    error = '';
    try {
      await call('/api/offices/create', {
        name: $t(team.nameKey),
        color: team.color,
        agents: team.members.map((m) => ({ name: m.name, description: $t(m.roleKey), prompt: m.prompt })),
      });
      // Reveal the hires one at a time. The office is already built by now —
      // this paces the moment so it reads as people arriving rather than a
      // progress bar completing.
      for (let i = 0; i < team.members.length; i++) {
        hired = i + 1;
        await pause(420);
      }
      phase = 'proving';
      await proveItWorks(team);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      phase = 'failed';
    }
  }

  /**
   * The payoff: a real agent answers a real question.
   *
   * Worth the wait. Reading one genuine sentence from the team you just hired
   * does more to explain this product than any amount of copy, and it proves the
   * provider configured a step earlier actually works — end to end, in front of
   * the person who set it up.
   */
  async function proveItWorks(team: Team): Promise<void> {
    const lead = team.members[0];
    try {
      // /api/chat/episodes is GET-only — creating one is /api/chat/start.
      const ep = await call('/api/chat/start', { title: `${$t(team.nameKey)} — first run` });
      const episodeId = ep?.episode?.id ?? ep?.id ?? ep?.episode_id;
      if (!episodeId) throw new Error($t('setup.team_no_convo'));
      const reply = await call('/api/chat/message', {
        episode_id: episodeId,
        message: `You are ${lead.name}, ${$t(lead.roleKey).toLowerCase()}. In one short sentence, introduce yourself and say what you will do for me first. Answer in the same language as this role title.`,
      });
      firstAnswer = String(reply?.message?.content ?? '').trim();
      phase = firstAnswer ? 'ready' : 'failed';
      if (!firstAnswer) error = $t('setup.team_no_answer');
    } catch (e) {
      // The office exists either way — never make a failed greeting look like a
      // failed setup, or the operator will start over and create it twice.
      error = e instanceof Error ? e.message : String(e);
      phase = 'failed';
    }
  }

  function reduceMotion(): boolean {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }
</script>

<section class="office-step" aria-live="polite">
  {#if phase === 'choosing'}
    <header>
      <h2>{$t('setup.team_title')}</h2>
      <p class="lede">
        {$t('setup.team_lede')}
      </p>
    </header>

    <div class="teams" role="list">
      {#each TEAMS as team, i (team.id)}
        <button
          class="team"
          role="listitem"
          style="--accent: {team.color}; --delay: {reduceMotion() ? 0 : i * 60}ms"
          on:click={() => hire(team)}
        >
          <span class="team-head">
            <span class="dot" aria-hidden="true"></span>
            <span class="team-name">{$t(team.nameKey)}</span>
          </span>
          <span class="tagline">{$t(team.tagKey)}</span>
          <ul class="roster">
            {#each team.members as m (m.name)}
              <li><strong>{m.name}</strong><span>{$t(m.roleKey)}</span></li>
            {/each}
          </ul>
          <span class="hire-cta">
            {$t('setup.team_hire')}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </button>
      {/each}
    </div>
  {:else if picked}
    <header>
      <h2>
        {#if phase === 'hiring'}{$t('setup.team_setting_up', { name: $t(picked.nameKey) })}
        {:else if phase === 'proving'}{$t('setup.team_greeting')}
        {:else if phase === 'ready'}{$t('setup.team_open', { name: $t(picked.nameKey) })}
        {:else}{$t('setup.team_created', { name: $t(picked.nameKey) })}{/if}
      </h2>
      <p class="lede">
        {#if phase === 'ready'}{$t('setup.team_ready_lede')}
        {:else if phase === 'failed'}{$t('setup.team_failed_lede')}
        {:else}{$t('setup.team_working_lede')}{/if}
      </p>
    </header>

    <ul class="arriving" style="--accent: {picked.color}">
      {#each picked.members as m, i (m.name)}
        <li class:in={i < hired}>
          <span class="avatar" aria-hidden="true">{m.name.slice(0, 1)}</span>
          <span class="who"><strong>{m.name}</strong><span>{$t(m.roleKey)}</span></span>
          <span class="tick" aria-hidden="true">
            {#if i < hired}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <path d="M4 12.5l5.5 5.5L20 7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {/if}
          </span>
        </li>
      {/each}
    </ul>

    {#if phase === 'ready' && firstAnswer}
      <figure class="greeting" style="--accent: {picked.color}">
        <figcaption>{$t('setup.team_says', { name: picked.members[0].name })}</figcaption>
        <blockquote>{firstAnswer}</blockquote>
      </figure>
    {/if}

    {#if phase === 'failed'}
      <p class="error" role="alert">{error}</p>
    {/if}

    {#if phase === 'ready' || phase === 'failed'}
      <button class="primary" on:click={() => dispatch('done')}>
        {$t('setup.team_enter')}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    {/if}
  {/if}
</section>

<style>
  .office-step { display: flex; flex-direction: column; gap: 22px; }
  header { display: flex; flex-direction: column; gap: 7px; }
  h2 { margin: 0; font-size: 21px; font-weight: 650; letter-spacing: -0.01em; color: var(--text-1, #f8fafc); }
  .lede { margin: 0; font-size: 14px; line-height: 1.6; color: var(--text-2, #94a3b8); max-width: 60ch; }

  .teams { display: grid; gap: 12px; }
  @media (min-width: 860px) { .teams { grid-template-columns: repeat(3, 1fr); } }

  .team {
    display: flex; flex-direction: column; gap: 10px; text-align: left; cursor: pointer;
    padding: 18px; border-radius: 14px; background: var(--surface-1, #16181d);
    border: 1px solid var(--border, #2a2e37); color: inherit; font: inherit;
    transition: border-color 200ms ease-out, transform 200ms ease-out, background 200ms ease-out;
    animation: rise 260ms ease-out backwards; animation-delay: var(--delay);
  }
  .team:hover, .team:focus-visible { border-color: var(--accent); background: var(--surface-2, #1b1e25); transform: translateY(-2px); }
  .team:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .team-head { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); flex: none; }
  .team-name { font-size: 15px; font-weight: 650; color: var(--text-1, #f8fafc); }
  .tagline { font-size: 13px; line-height: 1.55; color: var(--text-2, #94a3b8); }

  .roster { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
  .roster li { display: flex; gap: 7px; align-items: baseline; font-size: 12.5px; }
  .roster strong { color: var(--text-1, #e2e8f0); font-weight: 600; }
  .roster span { color: var(--text-3, #64748b); }

  .hire-cta {
    margin-top: 8px; display: inline-flex; align-items: center; gap: 6px; min-height: 24px;
    font-size: 13px; font-weight: 650; color: var(--accent);
  }

  .arriving { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .arriving li {
    display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px;
    background: var(--surface-1, #16181d); border: 1px solid var(--border, #2a2e37);
    opacity: 0.32; transform: translateY(6px);
    transition: opacity 260ms ease-out, transform 260ms ease-out, border-color 260ms ease-out;
  }
  .arriving li.in { opacity: 1; transform: none; border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
  .avatar {
    width: 34px; height: 34px; border-radius: 50%; flex: none; display: grid; place-items: center;
    font-size: 14px; font-weight: 700; color: #04211d;
    background: var(--accent);
  }
  .who { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
  .who strong { font-size: 14px; font-weight: 600; color: var(--text-1, #f8fafc); }
  .who span { font-size: 12.5px; color: var(--text-3, #64748b); }
  .tick { color: var(--accent); display: grid; place-items: center; width: 16px; }

  .greeting {
    margin: 0; padding: 16px 18px; border-radius: 14px;
    background: var(--surface-1, #16181d);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-left: 3px solid var(--accent);
    animation: rise 300ms ease-out backwards;
  }
  figcaption { font-size: 11.5px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); }
  blockquote { margin: 8px 0 0; font-size: 15px; line-height: 1.6; color: var(--text-1, #f1f5f9); }

  .error {
    margin: 0; font-size: 13px; line-height: 1.55; color: var(--red, #f87171);
    padding: 11px 13px; border-radius: 10px; background: color-mix(in srgb, #f87171 10%, transparent);
  }

  .primary {
    align-self: flex-start; display: inline-flex; align-items: center; gap: 8px;
    min-height: 44px; padding: 0 20px; border-radius: 10px; border: 0; cursor: pointer;
    background: var(--teal, #22c55e); color: #04211d; font-size: 14px; font-weight: 700;
    transition: filter 180ms ease-out;
  }
  .primary:hover { filter: brightness(1.08); }
  .primary:focus-visible { outline: 2px solid var(--teal, #22c55e); outline-offset: 3px; }

  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

  @media (prefers-reduced-motion: reduce) {
    .team, .greeting { animation: none; }
    .team:hover, .team:focus-visible { transform: none; }
    .arriving li { transition: opacity 120ms linear; transform: none; }
  }
</style>

<script lang="ts">
  // The "HQ tactical uplink" boot loader shown over the 3D office until it is
  // built, populated and painted. AgentWorld3D owns the readiness state; this
  // only draws it. The {#if} lives in here, not around the component, so the
  // `out:scale` dissolve still plays: Svelte 4 transitions are local, and one
  // on a component's root would be skipped when the parent's block removes it.
  import { scale } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';

  /** Overlay visible — `!sceneReady && !webglError` in the world. */
  export let show: boolean;
  export let bootError: string | null;
  export let dataError: boolean;
  export let steps: Array<{ label: string; done: boolean }>;
  export let status: string;
  export let onRetry: () => void;
</script>

{#if show}
  <div class="boot" out:scale={{ duration: 700, start: 1.05, opacity: 0, easing: quintOut }} aria-hidden="true">
    <div class="boot-grid"></div>
    <div class="boot-vignette"></div>
    <div class="boot-core">
      <div class="boot-radar">
        <span class="boot-ring boot-ring-1"></span>
        <span class="boot-ring boot-ring-2"></span>
        <span class="boot-ring boot-ring-3"></span>
        <span class="boot-cross boot-cross-h"></span>
        <span class="boot-cross boot-cross-v"></span>
        <span class="boot-sweep"></span>
        <span class="boot-blip boot-blip-1"></span>
        <span class="boot-blip boot-blip-2"></span>
        <span class="boot-blip boot-blip-3"></span>
      </div>
      <div class="boot-info">
        <div class="boot-title"><span>Kernl</span></div>
        <div class="boot-sub">H&middot;Q&nbsp;&nbsp;T A C T I C A L&nbsp;&nbsp;U P L I N K</div>
        {#if bootError || dataError}
          <div class="boot-err">
            <span class="boot-err-icon">&#9888;</span>
            <span class="boot-err-msg">{bootError ?? 'Could not load agent data.'}</span>
            <button class="boot-retry" on:click={onRetry}>Reintentar</button>
          </div>
        {:else}
          <ul class="boot-log boot-log-live">
            {#each steps as s (s.label)}
              <li class:done={s.done} class:active={!s.done}>
                <span class="boot-check">{s.done ? '✓' : '›'}</span>
                {s.label}{#if !s.done}<i class="boot-dots"></i>{/if}
              </li>
            {/each}
          </ul>
          <div class="boot-status">{status}</div>
          <div class="boot-bar"><span></span></div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Boot loader — "HQ tactical uplink" radar console ─────────── */
  .boot{position:absolute;inset:0;z-index:var(--z-hud);display:flex;align-items:center;justify-content:center;
    background:radial-gradient(125% 120% at 50% 38%, #0c1525 0%, #070b16 52%, #04060d 100%);
    overflow:hidden;font-family:'Manrope',-apple-system,sans-serif;will-change:transform,opacity}
  .boot-grid{position:absolute;inset:-2px;opacity:.55;pointer-events:none;
    background-image:linear-gradient(rgba(40,70,130,.55) 1px,transparent 1px),
      linear-gradient(90deg,rgba(40,70,130,.55) 1px,transparent 1px);
    background-size:46px 46px;
    -webkit-mask-image:radial-gradient(circle at 50% 44%, #000 0%, transparent 68%);
    mask-image:radial-gradient(circle at 50% 44%, #000 0%, transparent 68%);
    animation:bootGridDrift 16s linear infinite}
  @keyframes bootGridDrift{to{background-position:46px 46px}}
  .boot-vignette{position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(circle at 50% 42%, transparent 40%, rgba(2,4,10,.55) 100%)}

  .boot-core{position:relative;display:flex;flex-direction:column;align-items:center;gap:30px}

  .boot-radar{position:relative;width:190px;height:190px;border-radius:50%;
    background:radial-gradient(circle, rgba(46,92,168,.20) 0%, rgba(10,20,40,.04) 72%);
    box-shadow:inset 0 0 44px rgba(64,116,210,.22),0 0 0 1px rgba(96,140,220,.40),
      0 0 70px rgba(60,110,200,.14)}
  .boot-ring{position:absolute;border-radius:50%;border:1px solid rgba(96,140,220,.28)}
  .boot-ring-1{inset:24px}.boot-ring-2{inset:55px}.boot-ring-3{inset:86px;border-color:rgba(120,165,240,.5)}
  .boot-cross{position:absolute;background:rgba(96,140,220,.20)}
  .boot-cross-h{left:0;right:0;top:50%;height:1px}
  .boot-cross-v{top:0;bottom:0;left:50%;width:1px}
  .boot-sweep{position:absolute;inset:0;border-radius:50%;
    background:conic-gradient(from 0deg,rgba(130,195,255,.58) 0deg,rgba(130,195,255,.10) 24deg,transparent 58deg,transparent 360deg);
    -webkit-mask:radial-gradient(circle,#000 99%,transparent 100%);
    mask:radial-gradient(circle,#000 99%,transparent 100%);
    animation:bootSweep 2.4s linear infinite}
  @keyframes bootSweep{to{transform:rotate(360deg)}}
  .boot-radar::after{content:'';position:absolute;top:50%;left:50%;width:5px;height:5px;border-radius:50%;
    transform:translate(-50%,-50%);background:#a8caff;box-shadow:0 0 11px 2px rgba(130,195,255,.75)}
  .boot-blip{position:absolute;width:7px;height:7px;border-radius:50%;background:#cfa94e;
    box-shadow:0 0 9px 2px rgba(207,169,78,.65);opacity:0}
  .boot-blip-1{top:33%;left:61%;animation:bootBlip 2.4s linear infinite .35s}
  .boot-blip-2{top:63%;left:39%;animation:bootBlip 2.4s linear infinite 1.05s}
  .boot-blip-3{top:49%;left:71%;animation:bootBlip 2.4s linear infinite 1.75s}
  @keyframes bootBlip{0%{opacity:0;transform:scale(.4)}7%{opacity:1;transform:scale(1)}50%{opacity:0}100%{opacity:0}}

  .boot-info{text-align:center}
  .boot-title{font-weight:800;font-size:27px;letter-spacing:.3px;color:#e4ebf8;
    text-shadow:0 0 22px rgba(109,168,255,.30)}
  .boot-title span{color:#6da8ff}
  .boot-sub{margin-top:5px;font-size:9.5px;font-weight:700;color:#5f7299;letter-spacing:1px}
  .boot-log{list-style:none;margin:22px 0 0;padding:0;display:inline-block;min-width:216px;text-align:left;
    font:500 11px/1.95 ui-monospace,'SFMono-Regular',Menlo,monospace;color:#8298bd}
  .boot-log li{opacity:0;transform:translateX(-7px);display:flex;align-items:center;gap:7px;
    animation:bootLine .42s ease forwards;animation-delay:var(--d)}
  .boot-log li::before{content:'\203A';color:#6da8ff;font-weight:800}
  @keyframes bootLine{to{opacity:1;transform:none}}
  .boot-dots::after{content:'';animation:bootDots 1.5s steps(1,end) infinite}
  @keyframes bootDots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}100%{content:''}}
  /* Live checklist — driven by real boot state (no entrance animation). */
  .boot-log-live li{opacity:1;transform:none;animation:none;color:#6f86ab;transition:color .3s}
  .boot-log-live li::before{content:none}
  .boot-log-live li.done{color:#8fe3b3}
  .boot-check{display:inline-block;width:12px;text-align:center;font-weight:800;color:#6da8ff}
  .boot-log-live li.done .boot-check{color:#33d27e}
  .boot-status{margin-top:12px;font:600 10px/1 ui-monospace,monospace;color:#5f7299;letter-spacing:.5px;min-height:11px}
  .boot-err{margin:20px auto 0;max-width:300px;display:flex;flex-direction:column;align-items:center;gap:10px;
    color:#ffb3b3;font:600 12px/1.5 ui-monospace,monospace}
  .boot-err-icon{font-size:22px;color:#ff6b6b}
  .boot-err-msg{color:#d9a7a7;text-align:center}
  .boot-retry{margin-top:4px;background:#1a1018;border:1px solid #5a2030;color:#ff8a8a;
    padding:5px 16px;border-radius:4px;cursor:pointer;font:700 11px ui-monospace,monospace;letter-spacing:.5px}
  .boot-retry:hover{border-color:#ff6b6b;color:#ffb3b3}

  .boot-bar{margin:24px auto 0;width:236px;height:2px;border-radius:2px;
    background:rgba(96,140,220,.16);overflow:hidden}
  .boot-bar span{display:block;height:100%;width:38%;border-radius:2px;
    background:linear-gradient(90deg,transparent,#6da8ff,#a8caff,transparent);
    animation:bootScan 1.5s ease-in-out infinite}
  @keyframes bootScan{0%{transform:translateX(-130%)}100%{transform:translateX(360%)}}

  @media (prefers-reduced-motion:reduce){
    .boot-sweep,.boot-blip,.boot-bar span,.boot-grid,.boot-dots::after{animation:none}
    .boot-log li{opacity:1;transform:none;animation:none}
  }
</style>

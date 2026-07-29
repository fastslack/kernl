<script lang="ts">
  // /finance — migrated from services/dashboard/src/routes/finance/+page.svelte
  // (Fase 3). Formerly navigated by the finance-suite (UI-only); the page now
  // ships with the finance extension, which owns the data. The shell keeps
  // hydrating the finance / subscriptions / trading stores ("finance" +
  // "dashboard" WS channels for this path); we only subscribe.
  import Panel from '$shared/components/Panel.svelte';
  import Badge from '$shared/components/Badge.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import { fmtTime, timeAgo, formatCents } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const finance = ctx.getStore('finance');
  const subscriptions = ctx.getStore('subscriptions');
  const tradingStore = ctx.getStore('trading');

  // ── Finance ──
  $: fin = ($finance as any);
  $: accounts = (fin?.accounts ?? []) as any[];
  $: transactions = (fin?.recentTransactions ?? []) as any[];
  $: totalBalance = fin?.totalBalance ?? 0;
  $: monthSpend = fin?.monthSpend ?? 0;
  $: monthIncome = fin?.monthIncome ?? 0;
  $: budgets = (fin?.budgetStatus ?? []) as any[];
  $: spendByCategory = fin?.spendingByCategory ?? {};

  // ── Subscriptions ──
  $: subs = ($subscriptions as any);
  $: activeSubs = (subs?.activeList ?? []) as any[];
  $: subKpis = subs?.kpis ?? {};

  // ── Trading ──
  $: tr = ($tradingStore as any);
  $: tKpis = tr?.kpis ?? {};
  $: simKpis = tr?.simKpis ?? {};
  $: tAccounts = (tr?.accounts ?? []) as any[];
  $: strategies = (tr?.strategies ?? []) as any[];
  $: recentTrades = (tr?.recentTrades ?? []) as any[];
  $: recentPaper = (tr?.recentPaperTrades ?? []) as any[];
  $: liveWallet = tr?.liveWallet;
  $: simWallet = tr?.simWallet;
  $: feeder = tr?.feeder;
  $: formulaComp = (tr?.formulaComparison ?? []) as any[];
  $: topMovers = (feeder?.topMovers ?? []) as any[];
  $: lastTicks = feeder?.lastTicks ?? {};
  $: equityCurve = (tr?.simEquityCurve ?? []) as any[];
  $: graphAnalysis = tr?.graphAnalysis;
  $: simRuns = (tr?.simulationRuns ?? []) as any[];

  // ── Computed ──
  $: hasFinance = !!fin && (accounts.length > 0 || transactions.length > 0);
  $: hasTrading = !!tr;
  $: hasSubs = !!subs && activeSubs.length > 0;

  // ── Active tab ──
  let tab: 'overview' | 'trading' | 'market' | 'strategies' | 'paper' = 'overview';

  // ── Helpers ──
  function fmtPnl(v: number | null | undefined): string {
    if (v == null) return '—';
    const sign = v >= 0 ? '+' : '';
    return sign + v.toFixed(4);
  }
  function pnlColor(v: number | null | undefined): string {
    if (v == null || v === 0) return 'var(--text-3)';
    return v > 0 ? 'var(--green)' : 'var(--red)';
  }
  function fmtPct(v: number | null | undefined): string {
    if (v == null) return '—';
    return v.toFixed(1) + '%';
  }
  function fmtPrice(v: number | null | undefined): string {
    if (v == null) return '—';
    if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (v >= 1) return v.toFixed(2);
    if (v >= 0.01) return v.toFixed(4);
    return v.toFixed(6);
  }

  // ── All paper trades (raw from simWallet + recentPaper) ──
  $: allPaperTrades = (tr?.recentPaperTrades ?? []) as any[];
  // Aggregate open positions from simWallet
  $: openPositions = (simWallet?.holdings ?? []) as any[];
  $: openPortfolio = (simWallet?.openPortfolio ?? []) as any[];

  // ── Enriched strategies (parse symbols, add paper stats per strategy) ──
  interface StrategyView {
    id: string; name: string; description: string; preset: string;
    status: string; timeframe: string;
    symbolList: string[]; symbolDisplay: string;
    min_consensus: number; min_confidence: number;
    stop_loss_pct: number; take_profit_pct: number; max_position_pct: number;
    max_open_trades: number; cooldown_ms: number;
    total_trades: number; win_rate: number; total_pnl_cents: number;
    // Paper stats
    paperTotal: number; paperOpen: number; paperClosed: number;
    paperWins: number; paperPnl: number; paperWinRate: number;
    last_signal_at: string | null;
  }

  function buildStrategyViews(strats: any[], paperTrades: any[]): StrategyView[] {
    return strats.map((s: any) => {
      let syms: string[] = [];
      try { syms = typeof s.symbols === 'string' ? JSON.parse(s.symbols) : (s.symbols ?? []); } catch { syms = []; }
      const symDisplay = syms.length === 0 ? '—' : syms[0] === 'auto' ? 'Auto-pick' : syms.map((x: string) => x.replace('/EUR','')).join(', ');

      // Paper trade stats for this strategy (consensus trades only)
      const myPaper = paperTrades.filter((t: any) => t.strategy_id === s.id);
      const closed = myPaper.filter((t: any) => t.status === 'closed');
      const open = myPaper.filter((t: any) => t.status === 'open');
      const wins = closed.filter((t: any) => (t.pnl ?? 0) > 0);
      const totalPnl = closed.reduce((sum: number, t: any) => sum + (t.pnl ?? 0), 0);

      return {
        ...s,
        symbolList: syms,
        symbolDisplay: symDisplay,
        paperTotal: myPaper.length,
        paperOpen: open.length,
        paperClosed: closed.length,
        paperWins: wins.length,
        paperPnl: totalPnl,
        paperWinRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      };
    });
  }

  // We need ALL paper trades including those from DB, not just recentPaper
  // Use the raw formula_paper_trades data if available
  $: rawPaperAll = (() => {
    // Combine simWallet transactions + recentPaper + openPortfolio for the fullest picture
    const seen = new Set<string>();
    const result: any[] = [];
    for (const list of [allPaperTrades, openPortfolio]) {
      for (const t of list) {
        const key = t.id ?? `${t.formula_id}-${t.symbol}-${t.opened_at}`;
        if (!seen.has(key)) { seen.add(key); result.push(t); }
      }
    }
    return result;
  })();

  $: enrichedStrategies = buildStrategyViews(strategies, rawPaperAll);

  // ── Preset colors ──
  const PRESET_COLORS: Record<string, string> = {
    conservative: 'var(--blue)', balanced: 'var(--teal)', aggressive: 'var(--orange)',
    scalper: 'var(--red)', swing: 'var(--purple)', momentum: 'var(--gold)',
    lowrisk: 'var(--green)', yolo: 'var(--red)',
  };

  // ── Wallet helpers (avoid TS in templates) ──
  function walletHoldings(w: any): Array<{ currency: string; free: number; used: number; total: number }> {
    if (!w?.holdings) return [];
    return Object.entries(w.holdings)
      .map(([currency, b]) => ({ currency, free: (b as any).free ?? 0, used: (b as any).used ?? 0, total: (b as any).total ?? 0 }))
      .filter(h => h.total > 0);
  }
  $: liveHoldings = walletHoldings(liveWallet);

  function tickEntries(ticks: any): Array<{ sym: string; price: number; change: number; conSide: string; conCount: number }> {
    if (!ticks) return [];
    return Object.entries(ticks).map(([sym, t]) => ({
      sym, price: (t as any).price ?? (t as any).last ?? 0,
      change: (t as any).change_24h ?? 0,
      conSide: (t as any).consensus_side ?? '', conCount: (t as any).consensus_count ?? 0,
    }));
  }
  $: tickList = tickEntries(lastTicks);

  // ── Equity sparkline ──
  function sparkPath(data: any[], w: number, h: number): string {
    if (!data.length) return '';
    const vals = data.map(d => d.cumPnl ?? d.pnl ?? d.value ?? 0);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min || 1;
    return vals.map((v, i) => {
      const x = (i / Math.max(1, vals.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
  }
</script>

<!-- ═══ HEADER ═══ -->
<div class="fin-header">
  <div>
    <h1 class="fin-title">Finance & Trading</h1>
    <p class="fin-sub">Portfolio, markets, strategies & simulations</p>
  </div>
</div>

<!-- ═══ TAB BAR ═══ -->
<div class="fin-tabs">
  <button class="ft" class:active={tab === 'overview'} on:click={() => tab = 'overview'}>Overview</button>
  {#if hasTrading}
    <button class="ft" class:active={tab === 'trading'} on:click={() => tab = 'trading'}>Wallet</button>
    <button class="ft" class:active={tab === 'market'} on:click={() => tab = 'market'}>Market</button>
    <button class="ft" class:active={tab === 'strategies'} on:click={() => tab = 'strategies'}>Strategies</button>
    <button class="ft" class:active={tab === 'paper'} on:click={() => tab = 'paper'}>Paper Trading</button>
  {/if}
</div>

<!-- ═══ OVERVIEW TAB ═══ -->
{#if tab === 'overview'}
  <!-- Hero KPIs -->
  <div class="kpi-strip anim">
    {#if hasFinance}
      <div class="kpi-card">
        <span class="kc-label">Balance</span>
        <span class="kc-val" style="color:var(--green)">{formatCents(totalBalance)}</span>
      </div>
      <div class="kpi-card">
        <span class="kc-label">Month Spend</span>
        <span class="kc-val" style="color:var(--red)">{formatCents(monthSpend)}</span>
      </div>
      <div class="kpi-card">
        <span class="kc-label">Month Income</span>
        <span class="kc-val" style="color:var(--teal)">{formatCents(monthIncome)}</span>
      </div>
    {/if}
    {#if hasTrading && liveWallet}
      <div class="kpi-card">
        <span class="kc-label">Exchange</span>
        <span class="kc-val" style="color:var(--gold)">{fmtPrice(liveWallet.holdings?.EUR?.total ?? 0)} EUR</span>
      </div>
    {/if}
    {#if hasTrading}
      <div class="kpi-card">
        <span class="kc-label">Strategies</span>
        <span class="kc-val">{strategies.length}</span>
        <span class="kc-sub">{strategies.filter((/** @type {any} */ s) => s.status === 'active').length} active</span>
      </div>
      <div class="kpi-card">
        <span class="kc-label">Paper PnL</span>
        <span class="kc-val" style="color:{pnlColor(simKpis.consensusPnl)}">{fmtPnl(simKpis.consensusPnl)}</span>
        <span class="kc-sub">{simKpis.totalPaperTrades ?? 0} trades</span>
      </div>
    {/if}
    {#if hasSubs}
      <div class="kpi-card">
        <span class="kc-label">Subscriptions</span>
        <span class="kc-val">{formatCents(subKpis.monthlyTotal ?? 0)}/mo</span>
        <span class="kc-sub">{subKpis.active ?? 0} active</span>
      </div>
    {/if}
  </div>

  <div class="overview-grid anim">
    <!-- Accounts -->
    {#if accounts.length}
      <div class="ov-card">
        <div class="oc-title">Accounts</div>
        {#each accounts as acc}
          <div class="ov-row">
            <span class="ov-text">{acc.name}</span>
            <span class="ov-val" style="color:var(--green)">{formatCents(acc.balance_cents, acc.currency)}</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Exchange Holdings -->
    {#if liveHoldings.length}
      <div class="ov-card">
        <div class="oc-title">Exchange Holdings</div>
        {#each liveHoldings as h}
          <div class="ov-row">
            <span class="ov-text">{h.currency}</span>
            <span class="ov-val">{fmtPrice(h.total)}</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Market Feeder -->
    {#if feeder}
      <div class="ov-card">
        <div class="oc-title">
          Market Feeder
          <span class="feeder-status" class:active={feeder.status === 'running'}>{feeder.status ?? 'stopped'}</span>
        </div>
        <div class="feeder-meta">
          <span>{feeder.symbols?.length ?? 0} symbols</span>
          <span>{feeder.dynamicSymbols?.length ?? 0} dynamic</span>
          {#if feeder.lastTickAt}<span>Last: {timeAgo(feeder.lastTickAt)}</span>{/if}
        </div>
      </div>
    {/if}

    <!-- Top Movers -->
    {#if topMovers.length}
      <div class="ov-card">
        <div class="oc-title">Top Movers</div>
        {#each topMovers.slice(0, 6) as m}
          <div class="ov-row">
            <span class="ov-text mover-sym">{m.symbol?.replace('/EUR','')}</span>
            <span class="ov-val">{fmtPrice(m.price)}</span>
            <span class="ov-change" style="color:{(m.change_24h ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'}">
              {(m.change_24h ?? 0) >= 0 ? '+' : ''}{(m.change_24h ?? 0).toFixed(1)}%
            </span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Recent Transactions -->
    {#if transactions.length}
      <div class="ov-card">
        <div class="oc-title">Recent Transactions</div>
        {#each transactions.slice(0, 6) as tx}
          <div class="ov-row">
            <span class="ov-text">{tx.description}</span>
            <span class="ov-val" style="color:{tx.amount_cents < 0 ? 'var(--red)' : 'var(--green)'}">
              {tx.amount_cents < 0 ? '' : '+'}{formatCents(tx.amount_cents, tx.currency)}
            </span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Subscriptions -->
    {#if activeSubs.length}
      <div class="ov-card">
        <div class="oc-title">Subscriptions</div>
        {#each activeSubs.slice(0, 6) as sub}
          <div class="ov-row">
            <span class="ov-text">{sub.name}</span>
            <span class="ov-val">{formatCents(sub.amount_cents, sub.currency)}/{sub.billing_cycle?.slice(0,2) ?? 'mo'}</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Equity Curve -->
    {#if equityCurve.length > 2}
      <div class="ov-card">
        <div class="oc-title">Paper Equity Curve</div>
        <svg class="spark-svg" viewBox="0 0 300 80" preserveAspectRatio="none">
          <path d={sparkPath(equityCurve, 300, 80)} fill="none" stroke="var(--gold)" stroke-width="2" />
        </svg>
      </div>
    {/if}

    <!-- Budgets -->
    {#if budgets.length}
      <div class="ov-card">
        <div class="oc-title">Budgets</div>
        {#each budgets as b}
          <div class="budget-row">
            <div class="budget-info">
              <span class="ov-text">{b.name ?? b.category}</span>
              <span class="budget-pct">{formatCents(b.spent_cents ?? 0)} / {formatCents(b.limit_cents ?? 0)}</span>
            </div>
            <div class="budget-bar">
              <div class="budget-fill" style="width:{Math.min(100, Math.round(((b.spent_cents ?? 0) / Math.max(1, b.limit_cents ?? 1)) * 100))}%;background:{((b.spent_cents ?? 0) / Math.max(1, b.limit_cents ?? 1)) > 0.9 ? 'var(--red)' : 'var(--gold)'}"></div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if !hasFinance && !hasTrading && !hasSubs}
    <Panel cls="anim"><Empty message="No finance or trading data available yet." /></Panel>
  {/if}

<!-- ═══ WALLET TAB ═══ -->
{:else if tab === 'trading'}
  <div class="wallet-section anim">
    <!-- Live wallet -->
    {#if liveWallet}
      <div class="wallet-card">
        <div class="wc-header">
          <span class="wc-title">Exchange Wallet</span>
          {#each tAccounts as acc}
            <Badge text="{acc.name} ({acc.exchange_id})" />
          {/each}
        </div>
        <div class="wc-holdings">
          {#each liveHoldings as h}
              <div class="holding-card">
                <span class="hc-symbol">{h.currency}</span>
                <span class="hc-amount">{fmtPrice(h.total)}</span>
                {#if h.used > 0}
                  <span class="hc-used">{fmtPrice(h.used)} in use</span>
                {/if}
              </div>
          {/each}
        </div>
        <div class="wc-stats">
          <div class="ws-item"><span class="ws-label">Realized PnL</span><span class="ws-val" style="color:{pnlColor(liveWallet.realizedPnl)}">{fmtPnl(liveWallet.realizedPnl)}</span></div>
          <div class="ws-item"><span class="ws-label">Total Trades</span><span class="ws-val">{liveWallet.totalTrades ?? 0}</span></div>
          <div class="ws-item"><span class="ws-label">Open Trades</span><span class="ws-val">{liveWallet.openTrades ?? 0}</span></div>
        </div>
      </div>
    {/if}

    <!-- Sim wallet -->
    {#if simWallet}
      <div class="wallet-card sim">
        <div class="wc-header">
          <span class="wc-title">Paper Wallet</span>
          <Badge text="simulation" />
        </div>
        <div class="sim-kpis">
          <div class="sk-item"><span class="sk-val">{fmtPrice(simWallet.totalValue ?? 0)}</span><span class="sk-label">Total Value</span></div>
          <div class="sk-item"><span class="sk-val" style="color:{pnlColor(simWallet.realizedPnl)}">{fmtPnl(simWallet.realizedPnl)}</span><span class="sk-label">Realized PnL</span></div>
          <div class="sk-item"><span class="sk-val">{fmtPrice(simWallet.cash ?? 0)}</span><span class="sk-label">Cash</span></div>
          <div class="sk-item"><span class="sk-val">{fmtPrice(simWallet.invested ?? 0)}</span><span class="sk-label">Invested</span></div>
        </div>
        {#if simWallet.holdings?.length}
          <div class="oc-title" style="margin-top:12px">Positions</div>
          {#each simWallet.holdings as h}
            <div class="ov-row">
              <span class="ov-text mover-sym">{h.symbol?.replace('/EUR','')}</span>
              <span class="ov-val">{h.qty} @ {fmtPrice(h.avgPrice)}</span>
              <Badge text={h.side} variant={h.side === 'buy' ? 'done' : 'blocked'} />
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- Recent real trades -->
    {#if recentTrades.length}
      <div class="ov-card" style="margin-top:12px">
        <div class="oc-title">Recent Trades</div>
        {#each recentTrades.slice(0, 15) as t}
          <div class="trade-row">
            <Badge text={t.side} variant={t.side === 'buy' ? 'done' : 'blocked'} />
            <span class="tr-sym">{t.symbol}</span>
            <span class="tr-amount">{t.filled_amount ?? t.amount} @ {fmtPrice(t.filled_price ?? t.price)}</span>
            <span class="tr-pnl" style="color:{pnlColor(t.pnl)}">{fmtPnl(t.pnl)}</span>
            <span class="tr-date">{timeAgo(t.opened_at)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

<!-- ═══ MARKET TAB ═══ -->
{:else if tab === 'market'}
  <div class="market-section anim">
    <!-- Live tickers -->
    {#if tickList.length}
      <div class="oc-title">Live Prices</div>
      <div class="ticker-grid">
        {#each tickList as t}
          <div class="ticker-card">
            <span class="tk-sym">{t.sym.replace('/EUR','')}</span>
            <span class="tk-price">{fmtPrice(t.price)}</span>
            <span class="tk-change" style="color:{t.change >= 0 ? 'var(--green)' : 'var(--red)'}">
              {t.change >= 0 ? '+' : ''}{t.change.toFixed(2)}%
            </span>
            {#if t.conSide}
              <Badge text="{t.conSide} ({t.conCount})" variant={t.conSide === 'buy' ? 'done' : 'blocked'} />
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <!-- Top Movers -->
    {#if topMovers.length}
      <div class="oc-title" style="margin-top:20px">Top Movers (24h)</div>
      <div class="movers-table">
        <div class="mt-header">
          <span class="mt-col sym">Symbol</span>
          <span class="mt-col price">Price</span>
          <span class="mt-col change">Change</span>
          <span class="mt-col vol">Volume</span>
        </div>
        {#each topMovers.slice(0, 15) as m}
          <div class="mt-row">
            <span class="mt-col sym mover-sym">{m.symbol?.replace('/EUR','')}</span>
            <span class="mt-col price">{fmtPrice(m.price)}</span>
            <span class="mt-col change" style="color:{(m.change_24h ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'}">{(m.change_24h ?? 0) >= 0 ? '+' : ''}{(m.change_24h ?? 0).toFixed(2)}%</span>
            <span class="mt-col vol">{((m.volume ?? 0) / 1000).toFixed(0)}K</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Graph Analysis -->
    {#if graphAnalysis}
      <div class="graph-section">
        {#if graphAnalysis.leaders?.length}
          <div class="ov-card">
            <div class="oc-title">Market Leaders (PageRank)</div>
            {#each graphAnalysis.leaders.slice(0, 8) as l}
              <div class="ov-row">
                <span class="ov-text mover-sym">{l.symbol?.replace('/EUR','')}</span>
                <span class="ov-val">{(l.score ?? 0).toFixed(3)}</span>
              </div>
            {/each}
          </div>
        {/if}
        {#if graphAnalysis.divergences?.length}
          <div class="ov-card">
            <div class="oc-title">Divergences (Mean Reversion)</div>
            {#each graphAnalysis.divergences.slice(0, 6) as d}
              <div class="ov-row">
                <span class="ov-text">{d.a} ↔ {d.b}</span>
                <span class="ov-val">hist: {(d.historicalCorr ?? 0).toFixed(2)} → now: {(d.recentCorr ?? 0).toFixed(2)}</span>
              </div>
            {/each}
          </div>
        {/if}
        {#if graphAnalysis.predictiveEdges?.length}
          <div class="ov-card">
            <div class="oc-title">Predictive Edges (Lead/Lag)</div>
            {#each graphAnalysis.predictiveEdges.slice(0, 6) as e}
              <div class="ov-row">
                <span class="ov-text">{e.leader} → {e.follower}</span>
                <span class="ov-val">lag: {e.lag} · r={(e.correlation ?? 0).toFixed(2)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if !tickList.length && !topMovers.length}
      <Panel cls="anim"><Empty message="No market data. Start the feeder to collect tickers." /></Panel>
    {/if}
  </div>

<!-- ═══ STRATEGIES TAB ═══ -->
{:else if tab === 'strategies'}
  <div class="strategies-section anim">
    {#if !enrichedStrategies.length}
      <Panel><Empty message="No strategies configured." /></Panel>
    {:else}
      <div class="strategy-grid">
        {#each enrichedStrategies as s}
          <div class="strategy-card" style="--preset:{PRESET_COLORS[s.preset] ?? 'var(--text-3)'}">
            <!-- Header -->
            <div class="sc-top">
              <div class="sc-name-row">
                <span class="sc-preset-dot" style="background:var(--preset)"></span>
                <span class="sc-name">{s.name}</span>
              </div>
              <span class="sc-status" class:active={s.status === 'active'} class:paused={s.status === 'paused'} class:stopped={s.status === 'stopped'}>{s.status}</span>
            </div>
            {#if s.description}
              <p class="sc-desc">{s.description}</p>
            {/if}

            <!-- Symbols -->
            <div class="sc-symbols">
              {#each s.symbolList as sym}
                <span class="sc-sym">{sym === 'auto' ? '🔄 Auto' : sym.replace('/EUR','')}</span>
              {/each}
              <span class="sc-tf">{s.timeframe}</span>
            </div>

            <!-- Risk Parameters -->
            <div class="sc-section-label">Risk Parameters</div>
            <div class="sc-params-grid">
              <div class="sp-box">
                <span class="sp-num">{s.min_consensus}</span>
                <span class="sp-lbl">Consensus</span>
              </div>
              <div class="sp-box">
                <span class="sp-num">{s.min_confidence}%</span>
                <span class="sp-lbl">Min Conf</span>
              </div>
              <div class="sp-box">
                <span class="sp-num" style="color:var(--red)">{s.stop_loss_pct}%</span>
                <span class="sp-lbl">Stop Loss</span>
              </div>
              <div class="sp-box">
                <span class="sp-num" style="color:var(--green)">{s.take_profit_pct}%</span>
                <span class="sp-lbl">Take Profit</span>
              </div>
              <div class="sp-box">
                <span class="sp-num">{s.max_position_pct}%</span>
                <span class="sp-lbl">Max Pos</span>
              </div>
              <div class="sp-box">
                <span class="sp-num">{s.max_open_trades}</span>
                <span class="sp-lbl">Max Open</span>
              </div>
            </div>

            <!-- Performance: Real trades -->
            {#if s.total_trades > 0}
              <div class="sc-section-label">Real Trades</div>
              <div class="sc-perf-row">
                <div class="sp-perf-item">
                  <span class="sp-pval">{s.total_trades}</span>
                  <span class="sp-plbl">Trades</span>
                </div>
                <div class="sp-perf-item">
                  <span class="sp-pval">{fmtPct(s.win_rate)}</span>
                  <span class="sp-plbl">Win Rate</span>
                </div>
                <div class="sp-perf-item">
                  <span class="sp-pval" style="color:{pnlColor(s.total_pnl_cents)}">{formatCents(s.total_pnl_cents)}</span>
                  <span class="sp-plbl">PnL</span>
                </div>
              </div>
            {/if}

            <!-- Performance: Paper trades -->
            {#if s.paperTotal > 0}
              <div class="sc-section-label">Paper Trading</div>
              <div class="sc-perf-row">
                <div class="sp-perf-item">
                  <span class="sp-pval">{s.paperOpen}</span>
                  <span class="sp-plbl">Open</span>
                </div>
                <div class="sp-perf-item">
                  <span class="sp-pval">{s.paperClosed}</span>
                  <span class="sp-plbl">Closed</span>
                </div>
                <div class="sp-perf-item">
                  <span class="sp-pval">{s.paperWins}</span>
                  <span class="sp-plbl">Wins</span>
                </div>
                <div class="sp-perf-item">
                  <span class="sp-pval">{fmtPct(s.paperWinRate)}</span>
                  <span class="sp-plbl">Win %</span>
                </div>
                <div class="sp-perf-item">
                  <span class="sp-pval" style="color:{pnlColor(s.paperPnl)}">{fmtPnl(s.paperPnl)}</span>
                  <span class="sp-plbl">PnL</span>
                </div>
              </div>
            {:else if s.total_trades === 0}
              <div class="sc-no-data">No trades yet</div>
            {/if}

            <!-- Last signal -->
            {#if s.last_signal_at}
              <div class="sc-footer">Last signal: {timeAgo(s.last_signal_at)}</div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

<!-- ═══ PAPER TRADING TAB ═══ -->
{:else if tab === 'paper'}
  <div class="paper-section anim">
    <!-- Sim KPIs -->
    <div class="kpi-strip">
      <div class="kpi-card"><span class="kc-label">Paper Trades</span><span class="kc-val">{simKpis.totalPaperTrades ?? 0}</span></div>
      <div class="kpi-card"><span class="kc-label">Consensus Trades</span><span class="kc-val">{simKpis.consensusTrades ?? 0}</span></div>
      <div class="kpi-card"><span class="kc-label">Consensus Wins</span><span class="kc-val" style="color:var(--green)">{simKpis.consensusWins ?? 0}</span></div>
      <div class="kpi-card"><span class="kc-label">Win Rate</span><span class="kc-val">{fmtPct(simKpis.consensusWinRate)}</span></div>
      <div class="kpi-card"><span class="kc-label">Consensus PnL</span><span class="kc-val" style="color:{pnlColor(simKpis.consensusPnl)}">{fmtPnl(simKpis.consensusPnl)}</span></div>
    </div>

    <!-- Equity Curve -->
    {#if equityCurve.length > 2}
      <div class="ov-card">
        <div class="oc-title">Equity Curve (Consensus)</div>
        <svg class="equity-svg" viewBox="0 0 600 120" preserveAspectRatio="none">
          <line x1="0" y1="60" x2="600" y2="60" stroke="var(--border)" stroke-width="1" stroke-dasharray="4" />
          <path d={sparkPath(equityCurve, 600, 120)} fill="none" stroke="var(--gold)" stroke-width="2" />
        </svg>
      </div>
    {/if}

    <!-- Formula Comparison -->
    {#if formulaComp.length}
      <div class="ov-card">
        <div class="oc-title">Formula Performance</div>
        <div class="formula-table">
          <div class="ft-header">
            <span class="ft-col name">Formula</span>
            <span class="ft-col num">Trades</span>
            <span class="ft-col num">Wins</span>
            <span class="ft-col num">Win%</span>
            <span class="ft-col num">PnL</span>
            <span class="ft-col num">Best</span>
            <span class="ft-col num">Worst</span>
          </div>
          {#each formulaComp as f}
            <div class="ft-row">
              <span class="ft-col name formula-name">{f.formula_id ?? f.name}</span>
              <span class="ft-col num">{f.trades ?? f.total ?? 0}</span>
              <span class="ft-col num">{f.wins ?? 0}</span>
              <span class="ft-col num">{fmtPct(f.win_rate ?? f.winRate)}</span>
              <span class="ft-col num" style="color:{pnlColor(f.total_pnl ?? f.pnl)}">{fmtPnl(f.total_pnl ?? f.pnl)}</span>
              <span class="ft-col num" style="color:var(--green)">{fmtPnl(f.best_trade ?? f.best)}</span>
              <span class="ft-col num" style="color:var(--red)">{fmtPnl(f.worst_trade ?? f.worst)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Recent Paper Trades -->
    {#if recentPaper.length}
      <div class="ov-card">
        <div class="oc-title">Recent Paper Trades</div>
        {#each recentPaper as t}
          <div class="trade-row">
            <Badge text={t.side} variant={t.side === 'buy' ? 'done' : 'blocked'} />
            <span class="tr-sym">{t.symbol?.replace('/EUR','')}</span>
            <span class="tr-formula">{t.formula_id}</span>
            <span class="tr-amount">{fmtPrice(t.entry_price)} → {fmtPrice(t.exit_price)}</span>
            <span class="tr-pnl" style="color:{pnlColor(t.pnl)}">{fmtPnl(t.pnl)}</span>
            <span class="tr-conf">{t.confidence}%</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Simulation Runs -->
    {#if simRuns.length}
      <div class="ov-card">
        <div class="oc-title">Simulation History</div>
        {#each simRuns.slice(0, 10) as run}
          <div class="ov-row">
            <span class="ov-text">{run.symbol} · {run.timeframe} · {run.candles} candles</span>
            <span class="ov-val">{run.best_formula} <span style="color:{pnlColor(run.best_pnl)}">{fmtPnl(run.best_pnl)}</span></span>
          </div>
        {/each}
      </div>
    {/if}

    {#if !recentPaper.length && !formulaComp.length}
      <Panel><Empty message="No paper trades yet. Run a simulation or start the feeder." /></Panel>
    {/if}
  </div>
{/if}

<style>
  /* ── Header ──────────────────────────────────── */
  .fin-header { margin-bottom: 4px; }
  .fin-title { font-family: var(--font-display); font-size: 26px; font-weight: 700; color: var(--text-1); }
  .fin-sub { font-size: 13px; color: var(--text-3); margin-top: 2px; }

  /* ── Tab bar ─────────────────────────────────── */
  .fin-tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 0; }
  .ft {
    padding: 8px 18px;
    border: none; background: none;
    font-size: 12px; font-weight: 600; font-family: var(--font-body);
    color: var(--text-3); cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
    margin-bottom: -1px;
  }
  .ft:hover { color: var(--text-2); }
  .ft.active { color: var(--gold); border-bottom-color: var(--gold); }

  /* ── KPI Strip ───────────────────────────────── */
  .kpi-strip { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
  .kpi-card {
    flex: 1; min-width: 110px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 14px; display: flex; flex-direction: column;
  }
  .kc-label { font-size: 10px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px; }
  .kc-val { font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--text-1); line-height: 1.2; }
  .kc-sub { font-size: 10px; color: var(--text-3); margin-top: 2px; }

  /* ── Overview Grid ───────────────────────────── */
  .overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
  .ov-card {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 16px; overflow: hidden;
  }
  .oc-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--text-3); margin-bottom: 10px;
    display: flex; align-items: center; gap: 8px;
  }

  .ov-row {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
    font-size: 12px;
  }
  .ov-row:last-child { border-bottom: none; }
  .ov-text { flex: 1; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ov-val { font-family: var(--font-mono); font-size: 12px; color: var(--text-2); flex-shrink: 0; }
  .ov-change { font-family: var(--font-mono); font-size: 11px; flex-shrink: 0; min-width: 55px; text-align: right; }
  .mover-sym { font-weight: 600; color: var(--gold); }

  /* Feeder status */
  .feeder-status {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    background: rgba(240,71,112,0.12); color: var(--red);
  }
  .feeder-status.active { background: rgba(61,214,140,0.12); color: var(--green); }
  .feeder-meta { display: flex; gap: 12px; font-size: 11px; color: var(--text-3); }

  /* Budget bars */
  .budget-row { margin-bottom: 8px; }
  .budget-info { display: flex; justify-content: space-between; margin-bottom: 3px; }
  .budget-pct { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); }
  .budget-bar { height: 4px; background: var(--surface-3); border-radius: 2px; overflow: hidden; }
  .budget-fill { height: 100%; border-radius: 2px; transition: width 0.4s; }

  /* Sparkline */
  .spark-svg { width: 100%; height: 60px; }
  .equity-svg { width: 100%; height: 120px; margin-top: 8px; }

  /* ── Wallet ──────────────────────────────────── */
  .wallet-section { display: flex; flex-direction: column; gap: 12px; }
  .wallet-card {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px; overflow: hidden;
  }
  .wallet-card.sim { border-color: color-mix(in srgb, var(--gold) 30%, var(--border)); }
  .wc-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .wc-title { font-size: 14px; font-weight: 700; color: var(--text-1); flex: 1; }
  .wc-holdings { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .holding-card {
    background: var(--surface-2); border-radius: 8px; padding: 8px 14px;
    display: flex; flex-direction: column; min-width: 90px;
  }
  .hc-symbol { font-size: 12px; font-weight: 700; color: var(--gold); }
  .hc-amount { font-family: var(--font-mono); font-size: 14px; color: var(--text-1); }
  .hc-used { font-size: 10px; color: var(--text-3); }
  .wc-stats { display: flex; gap: 20px; }
  .ws-item { display: flex; flex-direction: column; }
  .ws-label { font-size: 10px; color: var(--text-3); text-transform: uppercase; }
  .ws-val { font-family: var(--font-mono); font-size: 14px; color: var(--text-1); font-weight: 600; }

  .sim-kpis { display: flex; gap: 16px; flex-wrap: wrap; }
  .sk-item { text-align: center; min-width: 80px; }
  .sk-val { display: block; font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--text-1); }
  .sk-label { font-size: 9px; color: var(--text-3); text-transform: uppercase; }

  /* ── Trade rows ──────────────────────────────── */
  .trade-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
    font-size: 12px;
  }
  .trade-row:last-child { border-bottom: none; }
  .tr-sym { font-weight: 600; color: var(--gold); min-width: 50px; }
  .tr-formula { font-size: 10px; color: var(--text-3); background: var(--surface-2); padding: 1px 6px; border-radius: 4px; }
  .tr-amount { flex: 1; color: var(--text-2); font-family: var(--font-mono); }
  .tr-pnl { font-family: var(--font-mono); font-weight: 600; min-width: 60px; text-align: right; }
  .tr-date { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); }
  .tr-conf { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); }

  /* ── Ticker grid ─────────────────────────────── */
  .ticker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .ticker-card {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 14px; display: flex; flex-direction: column; gap: 2px;
  }
  .tk-sym { font-size: 12px; font-weight: 700; color: var(--gold); }
  .tk-price { font-family: var(--font-mono); font-size: 16px; font-weight: 700; color: var(--text-1); }
  .tk-change { font-family: var(--font-mono); font-size: 12px; }

  /* ── Movers table ────────────────────────────── */
  .movers-table { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .mt-header { display: flex; padding: 8px 14px; background: var(--surface-2); font-size: 10px; color: var(--text-3); text-transform: uppercase; font-weight: 700; }
  .mt-row { display: flex; padding: 7px 14px; border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent); font-size: 12px; }
  .mt-row:last-child { border-bottom: none; }
  .mt-col { flex: 1; }
  .mt-col.sym { flex: 1.5; }
  .mt-col.price { font-family: var(--font-mono); color: var(--text-1); }
  .mt-col.change { font-family: var(--font-mono); }
  .mt-col.vol { font-family: var(--font-mono); color: var(--text-3); text-align: right; }

  /* Graph section */
  .graph-section { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 16px; }

  /* ── Strategy grid ───────────────────────────── */
  .strategy-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
  .strategy-card {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px 18px; overflow: hidden;
    border-top: 3px solid var(--preset, var(--border));
    transition: border-color 0.2s;
  }
  .strategy-card:hover { border-color: var(--border-h); }

  .sc-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .sc-name-row { display: flex; align-items: center; gap: 8px; }
  .sc-preset-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .sc-name { font-family: var(--font-display); font-size: 16px; font-weight: 700; color: var(--text-1); }
  .sc-status {
    font-size: 10px; padding: 3px 10px; border-radius: 10px; font-weight: 600;
    background: rgba(74,79,106,0.2); color: var(--text-3);
  }
  .sc-status.active { background: rgba(61,214,140,0.12); color: var(--green); }
  .sc-status.paused { background: rgba(212,168,75,0.12); color: var(--gold); }
  .sc-status.stopped { background: rgba(240,71,112,0.12); color: var(--red); }
  .sc-desc { font-size: 11px; color: var(--text-3); line-height: 1.4; margin: 0 0 10px; }

  .sc-symbols { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 12px; }
  .sc-sym {
    font-family: var(--font-mono); font-size: 10px; font-weight: 600;
    color: var(--gold); background: rgba(212,168,75,0.1);
    padding: 2px 8px; border-radius: 4px;
  }
  .sc-tf {
    font-family: var(--font-mono); font-size: 10px; font-weight: 600;
    color: var(--teal); background: rgba(61,214,200,0.1);
    padding: 2px 8px; border-radius: 4px; margin-left: auto;
  }

  .sc-section-label {
    font-size: 9px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.6px; color: var(--text-3); margin: 10px 0 6px;
  }

  .sc-params-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px;
  }
  .sp-box {
    text-align: center; background: var(--surface-2); border-radius: 6px;
    padding: 6px 4px;
  }
  .sp-num { display: block; font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text-1); line-height: 1.2; }
  .sp-lbl { font-size: 8px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.3px; }

  .sc-perf-row {
    display: flex; gap: 6px; flex-wrap: wrap;
  }
  .sp-perf-item {
    flex: 1; min-width: 50px; text-align: center;
    background: var(--surface-2); border-radius: 6px; padding: 6px 4px;
  }
  .sp-pval { display: block; font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text-1); line-height: 1.2; }
  .sp-plbl { font-size: 8px; color: var(--text-3); text-transform: uppercase; }

  .sc-no-data { font-size: 11px; color: var(--text-3); text-align: center; padding: 8px 0; margin-top: 8px; }
  .sc-footer { font-size: 10px; color: var(--text-3); margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); font-family: var(--font-mono); }

  /* ── Formula table ───────────────────────────── */
  .formula-table { overflow-x: auto; }
  .ft-header { display: flex; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 10px; color: var(--text-3); text-transform: uppercase; font-weight: 700; }
  .ft-row { display: flex; padding: 6px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent); font-size: 12px; }
  .ft-row:last-child { border-bottom: none; }
  .ft-col { flex: 1; min-width: 0; }
  .ft-col.name { flex: 2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ft-col.num { text-align: right; font-family: var(--font-mono); }
  .formula-name { color: var(--text-1); font-weight: 500; }

  /* ── Animation ───────────────────────────────── */
  .anim { animation: fadeUp 0.35s ease-out both; }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>

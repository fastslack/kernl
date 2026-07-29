/**
 * Trade execution cinematic — three-act animation that plays whenever a
 * trader agent fires a BUY or SELL order. Composes five low-level effects
 * (ticker-card, candlestick, coin-trail, price-line, chyron-label) plus an
 * optional material pulse on the trader's monitor.
 *
 *   Act 1 (0 → 0.35s)   ticker card pops above the trader's desk; monitor
 *                       pulses; (optional ground sweep)
 *   Act 2 (0.35 → 1.05s) card flies on a bezier to the market hub, leaving
 *                       a comet trail
 *   Act 3 (1.05 → 3.5s) at the hub: candlestick grows from baseline, coins
 *                       flow desk↔hub matching the side, price line draws
 *                       itself, chyron label shows the trade, optional P&L
 *                       glyph rises
 *
 * The orchestrator is sync — it registers Tickers with timing baked into
 * `onArrive` callbacks rather than spawning timers. One call from the host:
 *
 *   runTradeExecution({
 *     scene, registry: animRegistry,
 *     trader: { x, y, z },     // trader desk position
 *     marketHub: { x, y, z },  // center of trading room, above desks
 *     symbol: 'AAPL', side: 'BUY', quantity: 100, price: 185.32,
 *     pnl: undefined,          // SELL orders with realised P&L can set this
 *   });
 */

import type { AnimationRegistry } from '../registry.js';
import { tickerCard } from '../effects/ticker-card.js';
import { candlestick } from '../effects/candlestick.js';
import { coinTrail } from '../effects/coin-trail.js';
import { priceLine } from '../effects/price-line.js';
import { chyronLabel } from '../effects/chyron-label.js';
import { materialPulse } from '../effects/material-pulse.js';

export interface TradeExecutionOpts {
  scene: any;
  registry: AnimationRegistry;
  /** Trader desk position (floor-level y=0 assumed unless overridden). */
  trader: { x: number; y?: number; z: number };
  /** Market hub world position — typically center of trading room, y above desks. */
  marketHub: { x: number; y: number; z: number };
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  /** Realized P&L (for SELL orders). Shown as a +/- chyron above the hub. */
  pnl?: number;
  /** Optional monitor material to pulse during Act 1. */
  monitorMaterial?: any;
}

export function runTradeExecution(opts: TradeExecutionOpts): void {
  const isBuy = opts.side === 'BUY';
  const sideCss = isBuy ? '#00ff88' : '#ff4466';
  const sideHex = isBuy ? 0x00ff88 : 0xff4466;
  const tradeId = `${opts.symbol}:${Date.now()}`;

  const traderY = opts.trader.y ?? 0;
  // Cards/coins originate above the seated worker (~y=2.4 over desk floor,
  // 0.55 in front of the desk center where the seated worker actually sits).
  const cardStart = { x: opts.trader.x, y: traderY + 2.4, z: opts.trader.z + 0.55 };
  const coinDesk  = { x: opts.trader.x, y: traderY + 1.5, z: opts.trader.z + 0.55 };

  // ── Act 1: monitor pulse + card pop on desk ────────────────────────
  if (opts.monitorMaterial) {
    opts.registry.add(materialPulse(opts.monitorMaterial, {
      property: 'emissiveIntensity', min: 0.1, max: 1.5,
      speed: 22, durationSec: 0.55,
      tag: `trade-mon:${tradeId}`,
    }));
  }

  // ── Act 1+2: ticker card flies to market hub ───────────────────────
  opts.registry.add(tickerCard(opts.scene, {
    startWorld: cardStart,
    flyTo: opts.marketHub,
    side: opts.side,
    symbol: opts.symbol,
    quantity: opts.quantity,
    archHeight: 2.0,
    popInSec: 0.2, holdSec: 0.15, flySec: 0.7, fadeSec: 0.3,
    tag: `trade-card:${tradeId}`,
    onArrive: () => spawnAct3(opts, tradeId, isBuy, sideCss, sideHex, coinDesk),
  }));
}

/** Act 3 — fired by the ticker card's onArrive when it reaches the hub. */
function spawnAct3(
  opts: TradeExecutionOpts,
  tradeId: string,
  isBuy: boolean,
  sideCss: string,
  sideHex: number,
  coinDesk: { x: number; y: number; z: number },
): void {
  // ── Candlestick at the hub ─────────────────────────────────────────
  opts.registry.add(candlestick(opts.scene, {
    position: opts.marketHub,
    side: opts.side,
    bodyHeight: 1.6, bodyWidth: 0.5, bodyDepth: 0.5,
    wickLength: 0.55,
    durationSec: 2.5, growSec: 0.4, fadeSec: 0.6,
    tag: `trade-candle:${tradeId}`,
  }));

  // ── Coin trail: desk → hub for BUY, hub → desk for SELL ────────────
  const coinFrom = isBuy ? coinDesk : opts.marketHub;
  const coinTo   = isBuy ? opts.marketHub : coinDesk;
  opts.registry.add(coinTrail(opts.scene, {
    from: coinFrom, to: coinTo,
    count: 7, staggerSec: 0.09,
    coinDurationSec: 0.85, archHeight: 1.3,
    tag: `trade-coins:${tradeId}`,
  }));

  // ── Price line — small chart next to the candle ────────────────────
  opts.registry.add(priceLine(opts.scene, {
    origin: { x: opts.marketHub.x + 0.6, y: opts.marketHub.y, z: opts.marketHub.z },
    length: 1.6, amplitude: 0.45, samples: 22,
    color: sideHex, trend: opts.side,
    drawSec: 0.6, holdSec: 1.2, fadeSec: 0.5,
    tag: `trade-line:${tradeId}`,
  }));

  // ── Chyron label — full trade summary above the candle ─────────────
  const priceStr = opts.price > 0 ? ` @ ${opts.price.toFixed(2)}` : '';
  const arrow = isBuy ? '🟢' : '🔴';
  const summaryHtml =
    `<div style="font-size:9px;letter-spacing:2px;color:${sideCss};">${opts.side}</div>` +
    `<div style="margin-top:2px;font-size:13px;">${arrow} ${opts.quantity} <b>${opts.symbol}</b>${priceStr}</div>`;
  opts.registry.add(chyronLabel(opts.scene, {
    position: { x: opts.marketHub.x, y: opts.marketHub.y + 2.4, z: opts.marketHub.z },
    html: summaryHtml,
    color: sideCss,
    durationSec: 2.5, popInSec: 0.25, fadeSec: 0.5,
    riseHeight: 0.5,
    tag: `trade-chyron:${tradeId}`,
  }));

  // ── Optional P&L chyron — above the summary, color-coded ───────────
  if (opts.pnl !== undefined && Number.isFinite(opts.pnl)) {
    const positive = opts.pnl >= 0;
    const pnlColor = positive ? '#00ff88' : '#ff4466';
    const sign = positive ? '+' : '−';
    const pnlHtml =
      `<div style="font-size:14px;color:${pnlColor};font-weight:900;">` +
      `${sign}$${Math.abs(opts.pnl).toFixed(2)}` +
      `</div>`;
    opts.registry.add(chyronLabel(opts.scene, {
      position: { x: opts.marketHub.x, y: opts.marketHub.y + 3.3, z: opts.marketHub.z },
      html: pnlHtml,
      color: pnlColor,
      durationSec: 2.0, popInSec: 0.2, fadeSec: 0.4,
      riseHeight: 1.2,
      minWidthPx: 90,
      tag: `trade-pnl:${tradeId}`,
    }));
  }
}

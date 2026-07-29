/**
 * Minimal trading-domain types used by `src/core/` infrastructure
 * (rust-bridge adapter, formula-rust-adapter, rust-delegates).
 *
 * The trading extension's source-of-truth types live under
 * `assets/extensions/finance/trading/_module/`. Re-declaring them here lets the
 * core stay decoupled from any one trading implementation — the kernel
 * framework only needs OHLCV candles and a formula-result shape.
 */

/** OHLCV candle — the only shape rust-bridge callers in core need. */
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type OrderSide = "buy" | "sell";

/** Result of computing a single trading formula. */
export interface FormulaResult {
  side: OrderSide | null;
  confidence: number;
  indicators: Record<string, number>;
  reasoning: string;
}

/**
 * Optional context passed into formula computation. The kernel framework
 * doesn't construct this — it just passes it through to Rust — so we
 * only need the loosest shape that won't lose information.
 */
export interface FormulaContext {
  symbol: string;
  marketTicks?: Map<string, { price: number; change24h: number; consensus: string | null }>;
  btcCandles?: Candle[];
  params?: Record<string, number>;
}

/**
 * Rust Delegates — wrapper functions that delegate heavy operations
 * to the Rust mtwRequest bridge for performance.
 *
 * INTEGRATION IN src/index.ts:
 *
 * import { RustBridge } from "./core/rust/bridge.js";
 * import { createRustDelegates } from "./core/rust/delegates.js";
 * import { RustFormulaRegistry } from "./core/rust/formula-adapter.js";
 *
 * // After bridge config check:
 * if (config.bridge.enabled) {
 *   const rustBridge = new RustBridge({
 *     socketPath: process.env.RUST_BRIDGE_SOCKET ?? "/tmp/mtw-rust.sock",
 *     timeout: 30000,
 *     reconnect: true,
 *     reconnectDelay: 2000,
 *   });
 *   await rustBridge.connect();
 *
 *   const rust = createRustDelegates(rustBridge);
 *
 *   // Replace local formula computation with Rust:
 *   // Instead of: formulaRegistry.computeAll(symbol, candles, ...)
 *   // Use: rust.trading.computeFormulas(candles, symbol, ...)
 *
 *   // Replace local rate limiting with Rust:
 *   // Instead of: rateLimiter.consume(key)
 *   // Use: rust.security.rateLimitConsume(key)
 * }
 */

import type { RustBridge } from "./bridge.js";
import type { Candle } from "../types/extensions/trading.js";

/** SL/TP close signal returned by the Rust monitor */
export interface CloseSignal {
  trade_id: string;
  reason: "stop_loss" | "take_profit" | "trailing_stop";
  trigger_price: number;
}

/** Position to register with the Rust SL/TP monitor */
export interface MonitoredPosition {
  trade_id: string;
  symbol: string;
  side: "buy" | "sell";
  entry_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  trailing_stop_pct: number | null;
  amount: number;
}

/** Formula computation results from Rust */
export interface FormulaResults {
  results: Record<string, {
    side: "buy" | "sell" | null;
    confidence: number;
    indicators: Record<string, number>;
    reasoning: string;
  }>;
}

export function createRustDelegates(bridge: RustBridge) {
  return {
    trading: {
      /** Delegates formula computation to Rust (50x faster) */
      async computeFormulas(
        candles: Candle[],
        symbol: string,
        timeframe?: string,
      ): Promise<FormulaResults> {
        return bridge.call("trading.compute_formulas", {
          candles,
          symbol,
          timeframe,
        }) as Promise<FormulaResults>;
      },

      /** Register a position for SL/TP monitoring in Rust */
      async monitorAddPosition(position: MonitoredPosition): Promise<void> {
        await bridge.call("trading.monitor.add_position", position as unknown as Record<string, unknown>);
      },

      /** Check a single position against current price */
      async monitorCheck(
        tradeId: string,
        currentPrice: number,
      ): Promise<CloseSignal | null> {
        return bridge.call("trading.monitor.check", {
          trade_id: tradeId,
          current_price: currentPrice,
        }) as Promise<CloseSignal | null>;
      },

      /** Check all monitored positions against current prices */
      async monitorCheckAll(
        prices: Record<string, number>,
      ): Promise<CloseSignal[]> {
        return bridge.call("trading.monitor.check_all", {
          prices,
        }) as Promise<CloseSignal[]>;
      },

      /** Remove a position from monitoring */
      async monitorRemove(tradeId: string): Promise<void> {
        await bridge.call("trading.monitor.remove", { trade_id: tradeId });
      },

      /** Calculate PnL for a closed trade */
      async calculatePnl(
        entry: number,
        exit: number,
        amount: number,
        side: string,
        feeRate: number,
      ): Promise<number> {
        return bridge.call("trading.calculate_pnl", {
          entry,
          exit,
          amount,
          side,
          fee_rate: feeRate,
        }) as Promise<number>;
      },
    },

    security: {
      /** Consume a rate-limit token for the given key */
      async rateLimitConsume(
        key: string,
      ): Promise<{ allowed: boolean; remaining: number }> {
        return bridge.call("security.rate_limit.consume", {
          key,
        }) as Promise<{ allowed: boolean; remaining: number }>;
      },

      /** Check (without consuming) whether a key has remaining tokens */
      async rateLimitCheck(key: string): Promise<boolean> {
        return bridge.call("security.rate_limit.check", {
          key,
        }) as Promise<boolean>;
      },
    },
  };
}

export type RustDelegates = ReturnType<typeof createRustDelegates>;

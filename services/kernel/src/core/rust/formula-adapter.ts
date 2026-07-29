/**
 * Rust Formula Adapter — drop-in replacement for the local FormulaRegistry
 * that delegates all computation to the Rust mtwRequest bridge.
 *
 * The Rust side runs the same formulas but ~50x faster (no GC, SIMD, etc.).
 * This adapter converts between the Rust response format and the Kernl
 * FormulaResult interface so callers don't need to know which backend is active.
 *
 * Usage:
 *   const registry = new RustFormulaRegistry(rustBridge);
 *   const results = await registry.computeAll("BTCEUR", candles, "15m");
 *   // results is Map<string, FormulaResult> — same as local registry
 */

import type { RustBridge } from "./bridge.js";
import type { Candle, FormulaResult, FormulaContext } from "../types/extensions/trading.js";

/** Raw result shape returned by the Rust bridge */
interface RustFormulaResponse {
  results: Record<string, {
    side: "buy" | "sell" | null;
    confidence: number;
    indicators: Record<string, number>;
    reasoning: string;
  }>;
}

export class RustFormulaRegistry {
  constructor(private bridge: RustBridge) {}

  /**
   * Compute all formulas via Rust and return results in the standard
   * Kernl FormulaResult format.
   *
   * Drop-in replacement for FormulaRegistry.computeAll().
   */
  async computeAll(
    symbol: string,
    candles: Candle[],
    timeframe?: string,
    context?: FormulaContext,
  ): Promise<Map<string, FormulaResult>> {
    const rustResult = await this.bridge.call("trading.compute_formulas", {
      candles: candles.map((c) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
      symbol,
      timeframe,
      params: context?.params,
    }) as RustFormulaResponse;

    // Convert Rust response to Kernl FormulaResult Map
    const results = new Map<string, FormulaResult>();

    for (const [id, r] of Object.entries(rustResult.results)) {
      results.set(id, {
        side: r.side,
        confidence: r.confidence,
        indicators: r.indicators,
        reasoning: r.reasoning,
      });
    }

    return results;
  }

  /**
   * Async computeAll matching FormulaRegistry interface.
   * The feeder calls this with `await` — works for both sync (local) and async (Rust).
   */
  async computeAllAsync(
    symbol: string,
    candles: Candle[],
    timeframe?: string,
    context?: FormulaContext,
    _genomeFormulas?: Record<string, Record<string, number>>,
  ): Promise<Array<{ formula_id: string; formula_name: string; result: FormulaResult }>> {
    const map = await this.computeAll(symbol, candles, timeframe, context);
    return Array.from(map.entries()).map(([id, result]) => ({
      formula_id: id,
      formula_name: id,
      result,
    }));
  }

  /** Stub methods to satisfy FormulaRegistry interface */
  register(_formula: any): void {}
  listFormulas(): Array<{ id: string; name: string; description: string }> { return []; }
}

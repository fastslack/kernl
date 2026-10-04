/**
 * Token and cost accounting out of a Claude Agent SDK `result` message.
 *
 * The SDK reports usage twice: `usage` sums the whole query, and `modelUsage`
 * splits it per model — a run on Opus can still spend Haiku tokens on
 * subagents or summaries, so the split is what attributes them correctly.
 * `costUSD` is the CLI's own figure; under a Max/Pro subscription it is what
 * the same tokens would have cost on the API, not what was billed.
 */

export interface SdkModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}

interface ResultLike {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
  }>;
  total_cost_usd?: number;
}

/** One entry per model the query used; `fallbackModel` names a bare `usage`. */
export function sdkResultUsage(msg: unknown, fallbackModel: string): SdkModelUsage[] {
  const r = (msg ?? {}) as ResultLike;
  const perModel = Object.entries(r.modelUsage ?? {});
  if (perModel.length > 0) {
    return perModel.map(([model, u]) => ({
      model,
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cacheReadInputTokens ?? 0,
      cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
      costUsd: u.costUSD,
    }));
  }
  if (!r.usage) return [];
  return [{
    model: fallbackModel,
    inputTokens: r.usage.input_tokens ?? 0,
    outputTokens: r.usage.output_tokens ?? 0,
    cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0,
    costUsd: r.total_cost_usd,
  }];
}

/** The per-model entries added up, for callers that report one total. */
export function sumSdkUsage(rows: SdkModelUsage[]): Omit<SdkModelUsage, "model"> {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: undefined as number | undefined };
  for (const r of rows) {
    total.inputTokens += r.inputTokens;
    total.outputTokens += r.outputTokens;
    total.cacheReadTokens += r.cacheReadTokens;
    total.cacheWriteTokens += r.cacheWriteTokens;
    if (r.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + r.costUsd;
  }
  return total;
}

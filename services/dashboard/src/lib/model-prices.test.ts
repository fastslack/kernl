import { describe, it, expect } from 'bun:test';
import { fmtPrice } from './model-prices.js';

describe('fmtPrice', () => {
  it('prints input / output USD per million tokens, trimmed', () => {
    expect(fmtPrice({ inputPerMTok: 0.15, outputPerMTok: 0.6 })).toBe('$0.15 / $0.6');
    expect(fmtPrice({ inputPerMTok: 3, outputPerMTok: 15 })).toBe('$3 / $15');
    expect(fmtPrice({ inputPerMTok: 1.25, outputPerMTok: 10 })).toBe('$1.25 / $10');
  });
  it('keeps the digits a sub-cent price needs', () => {
    expect(fmtPrice({ inputPerMTok: 0.05, outputPerMTok: 0.4 })).toBe('$0.05 / $0.4');
    expect(fmtPrice({ inputPerMTok: 0.0375, outputPerMTok: 0.15 })).toBe('$0.0375 / $0.15');
  });
  it('says free when nothing is charged', () => {
    expect(fmtPrice({ inputPerMTok: 0, outputPerMTok: 0 })).toBe('free');
  });
});

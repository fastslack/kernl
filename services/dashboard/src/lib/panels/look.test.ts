import { describe, it, expect } from 'bun:test';
import { humanize, kindOf, hrefOf, tone, RED } from './look.js';

describe('humanize', () => {
  it('turns a raw key into words', () => {
    expect(humanize('new_with_email')).toBe('New with email');
    expect(humanize('response_rate_pct')).toBe('Response rate');
    expect(humanize('oportunidad')).toBe('Oportunidad');
  });
});

describe('kindOf', () => {
  it('reads what a value is', () => {
    expect(kindOf('email', 'geiser@gmail.com')).toBe('email');
    expect(kindOf('telefono', '0341 743-7378')).toBe('phone');
    expect(kindOf('web', 'centromedicogeiser.com.ar')).toBe('url');
    expect(kindOf('borradores', '1')).toBe('number');
    expect(kindOf('open', 214)).toBe('number');
    expect(kindOf('response_rate_pct', 0)).toBe('percent');
    expect(kindOf('etapa', 'Nuevo')).toBe('status');
    expect(kindOf('by_stage', { new: 1, won: 0 })).toBe('breakdown');
    expect(kindOf('nota', 'x'.repeat(80))).toBe('long');
    expect(kindOf('alta', '05/10')).toBe('text');
  });
});

describe('hrefOf', () => {
  it('builds the link a value opens', () => {
    expect(hrefOf('email', 'a@b.co')).toBe('mailto:a@b.co');
    expect(hrefOf('phone', '0341 743-7378')).toBe('tel:03417437378');
    expect(hrefOf('url', 'x.com.ar')).toBe('https://x.com.ar');
    expect(hrefOf('text', 'x')).toBeNull();
  });
});

describe('tone', () => {
  it('paints a lost or overdue state red', () => {
    expect(tone('vencido')).toBe(RED);
    expect(tone('lost')).toBe(RED);
  });
});

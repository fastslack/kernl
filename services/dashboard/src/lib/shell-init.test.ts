import { describe, it, expect } from 'bun:test';
import { needsSetupRedirect, googleAuthMessage, redirectFirstRun } from './shell-init.js';

describe('needsSetupRedirect', () => {
  it('sends a first-run user to the wizard', () => {
    expect(needsSetupRedirect(null, null, '/home')).toBe(true);
  });
  it('respects either flag', () => {
    expect(needsSetupRedirect('1', null, '/home')).toBe(false);
    expect(needsSetupRedirect(null, '1', '/home')).toBe(false);
  });
  it('does not redirect from the setup flow itself', () => {
    expect(needsSetupRedirect(null, null, '/setup')).toBe(false);
    expect(needsSetupRedirect(null, null, '/welcome')).toBe(false);
  });
});

describe('googleAuthMessage', () => {
  it('is null without a google_auth result', () => {
    expect(googleAuthMessage(new URLSearchParams('a=1'))).toBeNull();
  });
  it('announces a success', () => {
    expect(googleAuthMessage(new URLSearchParams('google_auth=success'))?.text)
      .toBe('✓ Google connected successfully');
  });
  it('carries the error, or a default one', () => {
    expect(googleAuthMessage(new URLSearchParams('google_auth=error&error=denied'))?.text)
      .toBe('⚠ Google auth failed: denied');
    expect(googleAuthMessage(new URLSearchParams('google_auth=error'))?.text)
      .toBe('⚠ Google auth failed: Unknown error');
  });
});

describe('redirectFirstRun — once per install, not per browser', () => {
  function env(flags: Record<string, string>, path = '/crm') {
    const store = new Map(Object.entries(flags));
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    (globalThis as any).window = { location: { pathname: path } };
    return store;
  }
  const kernel = (complete: boolean | 'down') => {
    const calls: string[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (complete === 'down') throw new Error('offline');
      return new Response(JSON.stringify({ complete }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it('a new browser on a set-up kernel goes to the dashboard and remembers it', async () => {
    const store = env({});
    const k = kernel(true);
    const went: string[] = [];
    await redirectFirstRun((u) => went.push(u), k.fn);
    expect(went).toEqual([]);
    expect(store.get('kernl.setupComplete')).toBe('1');
  });
  it('a kernel that was never set up opens the wizard', async () => {
    env({});
    const went: string[] = [];
    await redirectFirstRun((u) => went.push(u), kernel(false).fn);
    expect(went).toEqual(['/setup']);
  });
  it('a browser that finished setup tells the kernel and is not redirected', async () => {
    env({ 'kernl.setupComplete': '1' });
    const k = kernel(false);
    const went: string[] = [];
    await redirectFirstRun((u) => went.push(u), k.fn);
    expect(went).toEqual([]);
    expect(k.calls).toEqual(['POST /api/setup/complete']);
  });
  it('an unreachable kernel still sends a first run to the wizard', async () => {
    env({});
    const went: string[] = [];
    await redirectFirstRun((u) => went.push(u), kernel('down').fn);
    expect(went).toEqual(['/setup']);
  });
});

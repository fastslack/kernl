import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { requestUrl, isKernelApiUrl, installAuthFetch } from './auth-fetch.js';

describe('requestUrl', () => {
  it('resolves a string, a URL and a Request', () => {
    expect(requestUrl('/api/x')).toBe('/api/x');
    expect(requestUrl(new URL('http://h/api/y'))).toBe('http://h/api/y');
    expect(requestUrl(new Request('http://h/api/z'))).toBe('http://h/api/z');
  });
});

describe('isKernelApiUrl', () => {
  it('accepts relative and same-host absolute /api/ URLs', () => {
    expect(isKernelApiUrl('/api/tasks', 'dash:3086')).toBe(true);
    expect(isKernelApiUrl('http://dash:3086/api/tasks', 'dash:3086')).toBe(true);
  });
  it('rejects other paths and other hosts', () => {
    expect(isKernelApiUrl('/_app/version.json', 'dash:3086')).toBe(false);
    expect(isKernelApiUrl('https://example.com/api/x', 'dash:3086')).toBe(false);
  });
});

// The interceptor against a fake window: what it sends, and what a 401 or a
// 428 does. Globals are restored afterwards so no other test sees them.
describe('installAuthFetch', () => {
  const g = globalThis as any;
  const saved = { window: g.window, location: g.location, localStorage: g.localStorage };
  const sent: Array<{ url: string; auth: string | null }> = [];
  let status = 200;
  let on428Calls = 0;
  const loc = { host: 'dash', pathname: '/tasks', search: '?q=1', hash: '#h', href: '' };

  beforeAll(() => {
    g.location = loc;
    g.localStorage = { getItem: (k: string) => (k === 'kernel_auth_token' ? 'tok' : null) };
    g.window = {
      location: loc,
      fetch: async (input: RequestInfo | URL, init: RequestInit = {}) => {
        sent.push({ url: requestUrl(input), auth: new Headers(init.headers).get('Authorization') });
        return new Response('{}', { status });
      },
    };
    installAuthFetch(() => { on428Calls++; });
  });
  afterAll(() => {
    g.window = saved.window; g.location = saved.location; g.localStorage = saved.localStorage;
  });

  it('adds the bearer token to /api/ requests only', async () => {
    await g.window.fetch('/api/a');
    await g.window.fetch('/static/b');
    expect(sent.at(-2)).toEqual({ url: '/api/a', auth: 'Bearer tok' });
    expect(sent.at(-1)?.auth).toBeNull();
  });

  it('keeps an Authorization header the caller set', async () => {
    await g.window.fetch('/api/a', { headers: { Authorization: 'Bearer mine' } });
    expect(sent.at(-1)?.auth).toBe('Bearer mine');
  });

  it('reports a 428 and hands the response back', async () => {
    status = 428;
    const r = await g.window.fetch('/api/llm');
    expect(r.status).toBe(428);
    expect(on428Calls).toBe(1);
    expect(loc.href).toBe('');
  });

  it('sends a 401 to /login once, with next= and without the hash', async () => {
    status = 401;
    await g.window.fetch('/api/a');
    expect(loc.href).toBe('/login?next=' + encodeURIComponent('/tasks?q=1'));
    loc.href = '';
    await g.window.fetch('/api/a');
    expect(loc.href).toBe('');
  });

  it('installs only once', () => {
    const patched = g.window.fetch;
    installAuthFetch(() => {});
    expect(g.window.fetch).toBe(patched);
  });
});

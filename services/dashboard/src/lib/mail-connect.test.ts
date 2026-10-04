import { describe, it, expect, afterEach } from 'bun:test';
import { discoverMail, connectMail } from './mail-connect.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const stubFetch = (impl: () => Promise<Response>) => {
  globalThis.fetch = (async () => impl()) as unknown as typeof fetch;
};
const body = { email: 'maria@x.com', password: 'p' };

describe('mail-connect client never throws (the card must not stick in "testing")', () => {
  it('a network failure → discover null, connect unknown with the reason', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await discoverMail('maria@x.com')).toBeNull();
    expect(await connectMail(body)).toEqual({ ok: false, code: 'unknown', detail: 'Failed to fetch' });
  });

  it('a 200 whose body is not JSON (a proxy error page) → null / unknown', async () => {
    stubFetch(async () => new Response('<html>502</html>', { status: 200 }));
    expect(await discoverMail('maria@x.com')).toBeNull();
    const r = await connectMail(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unknown');
  });

  it('an HTTP error keeps reporting the status', async () => {
    stubFetch(async () => new Response('nope', { status: 502 }));
    expect(await connectMail(body)).toEqual({ ok: false, code: 'unknown', detail: 'HTTP 502' });
  });
});

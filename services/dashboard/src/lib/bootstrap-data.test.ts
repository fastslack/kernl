import { describe, it, expect, afterEach } from 'bun:test';
import { safeFetch } from './bootstrap-data.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stub(fn: () => Promise<Response>) {
  globalThis.fetch = fn as unknown as typeof fetch;
}

describe('safeFetch', () => {
  it('returns the parsed body of a 2xx answer', async () => {
    stub(async () => new Response('{"ok":true}', { status: 200 }));
    expect(await safeFetch('/api/x')).toEqual({ ok: true });
  });
  it('is null on a non-2xx answer', async () => {
    stub(async () => new Response('{"error":"no"}', { status: 500 }));
    expect(await safeFetch('/api/x')).toBeNull();
  });
  it('is null on a network error or a body that is not JSON', async () => {
    stub(async () => { throw new Error('down'); });
    expect(await safeFetch('/api/x')).toBeNull();
    stub(async () => new Response('<html>', { status: 200 }));
    expect(await safeFetch('/api/x')).toBeNull();
  });
});

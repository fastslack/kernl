import type { ExtPageContext } from '$shared/types';

/**
 * Path-style API helper for the training pages: calls the RPC action derived
 * from the REST path, falling back to the HTTP route when RPC is unavailable.
 * Failures are reported through `onError` and resolve to `{ _error: true }`
 * instead of throwing.
 */
export function createApi(ctx: ExtPageContext, onError: (msg: string) => void) {
  return async function api(path: string, opts?: RequestInit): Promise<any> {
    // Convert path to RPC action name: /api/training/log-set → training.logSet
    const action = path.replace(/^\/api\//, '').replace(/\//g, '.').replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    const body = opts?.body ? JSON.parse(opts.body as string) : {};
    try {
      return await ctx.rpc(action, body, async () => {
        const res = await ctx.fetchRaw(path, {
          headers: { 'Content-Type': 'application/json' },
          ...opts,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          onError(err.error || `Request failed: ${res.status}`);
          return { _error: true };
        }
        return await res.json();
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Network error');
      return { _error: true };
    }
  };
}

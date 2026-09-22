/**
 * A dashboard action reaches the kernel by WS RPC or by its HTTP twin, and
 * both run the same function there. Running it twice is the thing to avoid:
 * racing the roads doubled every slow write, and retrying an answered error
 * over HTTP ran the mutation again.
 */

import { describe, it, expect } from 'bun:test';
import { callWithFallback, isReadAction, RpcAnsweredError, RpcNotSentError } from './rpc-call.js';

const never = <T>() => new Promise<T>(() => {});
const counter = () => {
	let n = 0;
	return { http: async () => { n++; return 'http'; }, calls: () => n };
};

describe('isReadAction', () => {
	it('follows the kernel read-only suffixes, plus dashboard.*', () => {
		for (const a of ['agents.detail', 'skills.list', 'config.ai.get', 'dashboard.full']) expect(isReadAction(a)).toBe(true);
		for (const a of ['agents.run', 'agents.create', 'channels.start', 'notifications.markRead']) expect(isReadAction(a)).toBe(false);
	});
});

describe('callWithFallback', () => {
	it('goes straight to HTTP when the socket is down', async () => {
		const h = counter();
		expect(await callWithFallback({ action: 'agents.run', connected: false, ws: never, http: h.http })).toBe('http');
		expect(h.calls()).toBe(1);
	});

	it('never races a slow write: it waits for WS and does not call HTTP', async () => {
		const h = counter();
		const ws = () => new Promise<string>((r) => setTimeout(() => r('ws'), 30));
		expect(await callWithFallback({ action: 'agents.run', connected: true, ws, http: h.http, raceAfterMs: 1 })).toBe('ws');
		expect(h.calls()).toBe(0);
	});

	it('does not retry a write the kernel answered with an error', async () => {
		const h = counter();
		const ws = async () => { throw new RpcAnsweredError('Agent not found'); };
		await expect(callWithFallback({ action: 'agents.delete', connected: true, ws, http: h.http })).rejects.toThrow('Agent not found');
		expect(h.calls()).toBe(0);
	});

	it('does not retry a write that timed out, since it may have run', async () => {
		const h = counter();
		const ws = async () => { throw new Error('RPC timeout: agents.run'); };
		await expect(callWithFallback({ action: 'agents.run', connected: true, ws, http: h.http })).rejects.toThrow('RPC timeout');
		expect(h.calls()).toBe(0);
	});

	it('sends a write over HTTP when the WS never sent it', async () => {
		const h = counter();
		const ws = async () => { throw new RpcNotSentError('agents.run'); };
		expect(await callWithFallback({ action: 'agents.run', connected: true, ws, http: h.http })).toBe('http');
		expect(h.calls()).toBe(1);
	});

	it('races a slow read', async () => {
		const h = counter();
		expect(await callWithFallback({ action: 'agents.detail', connected: true, ws: never, http: h.http, raceAfterMs: 1 })).toBe('http');
	});

	it('keeps an answered error on a read too', async () => {
		const h = counter();
		const ws = async () => { throw new RpcAnsweredError('Agent not found'); };
		await expect(callWithFallback({ action: 'agents.detail', connected: true, ws, http: h.http, raceAfterMs: 50 })).rejects.toThrow('Agent not found');
		await new Promise((r) => setTimeout(r, 80));
		expect(h.calls()).toBe(0);
	});
});

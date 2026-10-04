// ── Shell data fetching ─────────────────────────────────────────────
import { storeMap, lastRefresh, activeTheme, type ActiveTheme } from './stores.js';
import { rpcOrCall } from './ws.js';

/** GET `url` as JSON; `null` on a non-2xx answer, a network error or a bad body. */
export async function safeFetch(url: string) {
	try {
		const r = await fetch(url);
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	}
}

/**
 * All dashboard data now arrives via WebSocket channels (mtwRequest publisher).
 * No HTTP polling needed — stores are filled by ws.ts handleMtwMessage().
 * Only fetch data that has no WebSocket channel equivalent.
 */
export async function fetchInitialData() {
	// Fetch init data — uses RPC when WS is connected, falls back to HTTP
	const [skills, marketplace, aiConfig, google, apiReg, rssReg, themeData] = await Promise.allSettled([
		// Skills come from the extension registry, not the retired /api/skills
		// one — that endpoint only ever saw the legacy JS-plugin flavour, so the
		// AI overview counted 5 skills while the agents used a different set.
		safeFetch('/api/extensions?type=skill&status=active'),
		rpcOrCall('marketplace.list', {}, () => safeFetch('/api/marketplace')),
		rpcOrCall('config.ai.get', {}, () => safeFetch('/api/config/ai')),
		rpcOrCall('google.status', {}, () => safeFetch('/api/google/status')),
		rpcOrCall('registry.apis.list', {}, () => safeFetch('/api/registry/apis')),
		rpcOrCall('registry.rss.list', {}, () => safeFetch('/api/registry/rss')),
		rpcOrCall('marketplace.theme.active', {}, () => safeFetch('/api/marketplace/theme/active')),
	]);

	// `items` from /api/extensions → `skills` so consumers keep their shape.
	if (skills.status === 'fulfilled' && skills.value) {
		storeMap['skills'].set({ skills: (skills.value as { items?: unknown[] }).items ?? [] });
	}
	if (marketplace.status === 'fulfilled' && marketplace.value) storeMap['marketplace'].set(marketplace.value);
	if (aiConfig.status === 'fulfilled' && aiConfig.value) storeMap['aiConfig'].set(aiConfig.value);
	if (google.status === 'fulfilled' && google.value) storeMap['google'].set(google.value);
	if (apiReg.status === 'fulfilled' && apiReg.value) storeMap['apiRegistry'].set(apiReg.value);
	if (rssReg.status === 'fulfilled' && rssReg.value) storeMap['rssRegistry'].set(rssReg.value);
	if (themeData.status === 'fulfilled' && themeData.value?.theme) activeTheme.set(themeData.value.theme as ActiveTheme);

	lastRefresh.set(new Date());
}

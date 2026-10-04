// One-shot chores the root layout runs when the shell initializes: the
// first-run redirect to the setup wizard, the Google OAuth result banner and
// the eviction of stale service workers. Each reads the live window, so they
// are only called from the layout's init, never at import time.

type Goto = (url: string, opts?: { replaceState?: boolean }) => unknown;

/**
 * Whether a first-run user should be sent to the wizard. Either flag counts:
 *   kernl.setupComplete — new wizard at /setup
 *   kernl.welcomeSeen   — legacy welcome flag (kept for users
 *                         who already dismissed the old welcome)
 */
export function needsSetupRedirect(setupDone: string | null, welcomeSeen: string | null, path: string): boolean {
	const onSetupFlow = path === '/setup' || path === '/welcome';
	return !setupDone && !welcomeSeen && !onSetupFlow;
}

/**
 * First-run redirect to the setup wizard — fire-and-forget. The caller must
 * NOT early-return on it: the layout still needs to fetch the manifest, set
 * up the clock, and open the WebSocket so when the user dismisses the wizard
 * (or lands on it directly) the rest of the dashboard is fully initialized.
 */
export function redirectFirstRun(goto: Goto) {
	try {
		const setupDone   = localStorage.getItem('kernl.setupComplete');
		const welcomeSeen = localStorage.getItem('kernl.welcomeSeen');
		if (needsSetupRedirect(setupDone, welcomeSeen, window.location.pathname)) {
			goto('/setup', { replaceState: true });
		}
	} catch {
		/* localStorage disabled (privacy mode, sandboxed iframe) — skip the
		   redirect rather than block the dashboard. */
	}
}

export interface BannerMessage { text: string; bg: string; col: string }

/** The banner for a `?google_auth=` result, or null when there is none. */
export function googleAuthMessage(qs: URLSearchParams): BannerMessage | null {
	const googleAuth = qs.get('google_auth');
	if (!googleAuth) return null;
	return googleAuth === 'success'
		? { text: '✓ Google connected successfully', bg: 'var(--green)', col: 'var(--bg)' }
		: { text: '⚠ Google auth failed: ' + (qs.get('error') || 'Unknown error'), bg: 'var(--red)', col: '#fff' };
}

/** Google OAuth redirect handling: strip the query and flash the result. */
export function showGoogleAuthBanner() {
	const msg = googleAuthMessage(new URLSearchParams(window.location.search));
	if (!msg) return;
	window.history.replaceState({}, '', window.location.pathname + window.location.hash);
	setTimeout(() => {
		const banner = document.createElement('div');
		banner.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);background:${msg.bg};color:${msg.col};padding:10px 24px;border-radius:8px;font-weight:600;font-size:14px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.3)`;
		banner.textContent = msg.text;
		document.body.appendChild(banner);
		setTimeout(() => banner.remove(), 4000);
	}, 500);
}

/**
 * Evict any residual service worker left behind from a previous PWA
 * build of this dashboard. Those SWs keep serving stale chunks and
 * trigger "new version available" banners on every navigation because
 * their cached /_app/version.json drifts away from what the server sends.
 */
export function evictServiceWorkers() {
	if ('serviceWorker' in navigator) {
		navigator.serviceWorker.getRegistrations()
			.then((regs) => Promise.all(regs.map((r) => r.unregister())))
			.catch(() => {});
	}
}

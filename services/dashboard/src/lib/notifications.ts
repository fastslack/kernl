// ── Notifications ───────────────────────────────────────────────────
// Fetching and marking read, shared by the header dropdown and the
// /notifications page so both keep the `notifications` / `unreadCount`
// stores in step the same way.
import { notifications, unreadCount, type DashboardNotification } from './stores.js';
import { rpcOrCall } from './ws.js';
import { safeFetch } from './bootstrap-data.js';

/** `list` with notification `id` marked read. */
export function withRead(list: DashboardNotification[], id: string): DashboardNotification[] {
	return list.map(n => n.id === id ? { ...n, read: 1 } : n);
}

/** `list` with every notification marked read. */
export function withAllRead(list: DashboardNotification[]): DashboardNotification[] {
	return list.map(n => ({ ...n, read: 1 }));
}

export async function fetchNotifications() {
	const r = await rpcOrCall('notifications.list', {}, () => safeFetch('/api/notifications'));
	if (r) {
		const d = r as any;
		notifications.set(d.notifications ?? []);
		unreadCount.set(d.unread ?? 0);
	}
}

function postRead(body: Record<string, unknown>) {
	return fetch('/api/notifications/read', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	}).then(r => r.json());
}

export async function markNotifRead(id: string) {
	await rpcOrCall('notifications.markRead', { id }, () => postRead({ id }));
	notifications.update(list => withRead(list, id));
	unreadCount.update(c => Math.max(0, c - 1));
}

// `{}` is what the kernel reads as "all": the route marks everything read
// when the body carries no `id`.
export async function markAllNotifsRead() {
	await rpcOrCall('notifications.markAllRead', {}, () => postRead({}));
	notifications.update(withAllRead);
	unreadCount.set(0);
}

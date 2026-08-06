// API client — all fetch helpers with WS RPC first, HTTP fallback
import { rpcOrCall, rpc } from './ws.js';

/** Get stored auth token from localStorage */
export function getAuthToken(): string | null {
	return localStorage.getItem('kernel_auth_token');
}

/** Store auth token in localStorage */
export function setAuthToken(token: string): void {
	localStorage.setItem('kernel_auth_token', token);
}

/** Clear auth token */
export function clearAuthToken(): void {
	localStorage.removeItem('kernel_auth_token');
}

async function apiFetch(url: string, opts: RequestInit = {}): Promise<unknown> {
	const token = getAuthToken();
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (token) headers['Authorization'] = `Bearer ${token}`;

	const r = await fetch(url, { headers, ...opts });

	if (r.status === 401) {
		// Send the user to /login rather than opening a native prompt().
		//
		// prompt() is modal and blocking: any browser that suppresses dialogs —
		// headless Chrome, an embedded webview, a user who ticked "prevent this
		// page from creating more dialogs" — simply never returns, so the whole
		// dashboard hangs with no error. That is what made every UI end-to-end
		// test time out at 60s without a single failed assertion. It is also a
		// poor way to ask for a 64-character token when there is a login screen
		// built for exactly this.
		clearAuthToken();
		if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
			const next = encodeURIComponent(
				window.location.pathname + window.location.search + window.location.hash,
			);
			window.location.href = `/login?next=${next}`;
		}
		throw new Error('Authentication required');
	}

	if (!r.ok) {
		const err = await r.json().catch(() => ({ error: r.statusText })) as { error?: string };
		throw new Error(err.error || r.statusText);
	}
	return r.json();
}

function post(url: string, body: unknown) {
	return apiFetch(url, { method: 'POST', body: JSON.stringify(body) });
}

function put(url: string, body: unknown) {
	return apiFetch(url, { method: 'PUT', body: JSON.stringify(body) });
}

function del(url: string) {
	return apiFetch(url, { method: 'DELETE' });
}

// ── Dashboard data ─────────────────────────────────────────────────
export async function fetchDashboard() {
	return rpcOrCall('dashboard.full', {}, () => apiFetch('/api/dashboard'));
}

export async function fetchDashboardSection(section: string) {
	return rpcOrCall('dashboard.' + section, {}, () => apiFetch('/api/dashboard/' + section));
}

export async function fetchAgendaToday() {
	try {
		return await rpcOrCall('agendaBrain.today', {}, () => apiFetch('/api/dashboard/agenda-today'));
	} catch { return null; }
}

// ── Tasks ──────────────────────────────────────────────────────────
export function updateTaskStatus(id: string, status: string) {
	return rpcOrCall('tasks.updateStatus', { id, status }, () => post('/api/tasks/update-status', { id, status }));
}

export function updateTaskPriority(id: string, priority: string) {
	return rpcOrCall('tasks.updatePriority', { id, priority }, () => post('/api/tasks/update-priority', { id, priority }));
}

export function updateTaskField(id: string, field: string, value: unknown) {
	return rpcOrCall('tasks.updateField', { id, field, value }, () => post('/api/tasks/update-field', { id, field, value }));
}

export function createTask(task: { title: string; description?: string; priority?: string; context?: string; tags?: string; due_date?: string; estimated_minutes?: number }) {
	return rpcOrCall('tasks.create', task, () => post('/api/tasks/create', task));
}

export function deleteTask(id: string) {
	return rpcOrCall('tasks.delete', { id }, () => post('/api/tasks/delete', { id }));
}

export async function fetchAllTasks(): Promise<any[]> {
	const r = await rpcOrCall('tasks.list', {}, () => apiFetch('/api/tasks/all'));
	return (r as any)?.tasks ?? r ?? [];
}

// ── Planner / calendar management ─────────────────────────────────
// The calendar payload (same shape as the `planner` store) — used to refresh
// the grid after a mutation. The HTTP route always exists; WS is tried first.
export async function fetchCalendar(start: string, days: number): Promise<any> {
	return rpcOrCall('dashboard.calendar', { start, days },
		() => apiFetch(`/api/dashboard/calendar?start=${encodeURIComponent(start)}&days=${days}`));
}

// Reschedule a task = move its due_date (routes through tasks.updateField → service).
export function rescheduleTask(id: string, dueDate: string) {
	return updateTaskField(id, 'due_date', dueDate);
}
export function completeTask(id: string) {
	return updateTaskStatus(id, 'done');
}
export function renameTask(id: string, title: string) {
	return updateTaskField(id, 'title', title);
}

// Reminders (WS RPC — no legacy HTTP route).
export function createReminder(r: { title: string; trigger_at: string; repeat?: string; body?: string }) {
	return rpc('reminders.create', r);
}
export function rescheduleReminder(id: string, triggerAt: string) {
	return rpc('reminders.reschedule', { id, trigger_at: triggerAt });
}
export function renameReminder(id: string, title: string) {
	return rpc('reminders.update', { id, title });
}

// Events (WS RPC).
export function createEvent(e: { title: string; start_at: string; end_at?: string; type?: string }) {
	return rpc('events.create', e);
}
export function rescheduleEvent(id: string, startAt: string) {
	return rpc('events.reschedule', { id, start_at: startAt });
}
export function completeEvent(id: string) {
	return rpc('events.update', { id, status: 'completed' });
}
export function renameEvent(id: string, title: string) {
	return rpc('events.update', { id, title });
}
export function cancelEvent(id: string) {
	return rpc('events.update', { id, status: 'cancelled' });
}

// ── Contacts / CRM ────────────────────────────────────────────────
export async function fetchContacts(opts: { q?: string; relationship?: string; page?: number; limit?: number } = {}): Promise<{ contacts: any[]; total: number; page: number }> {
	const params = new URLSearchParams();
	if (opts.q) params.set('q', opts.q);
	if (opts.relationship) params.set('relationship', opts.relationship);
	if (opts.page) params.set('page', String(opts.page));
	if (opts.limit) params.set('limit', String(opts.limit));
	const r = await rpcOrCall('contacts.list', opts, () => apiFetch('/api/contacts/all?' + params.toString()));
	return r as any;
}

export async function fetchContactDetail(id: string): Promise<any> {
	return rpcOrCall('contacts.detail', { id }, () => apiFetch('/api/contacts/detail?id=' + encodeURIComponent(id)));
}

export function createContact(c: { name: string; email?: string; phone?: string; company?: string; relationship?: string; notes?: string }) {
	return rpcOrCall('contacts.create', c, () => post('/api/contacts/create', c));
}

export function updateContact(c: { id: string; name?: string; email?: string; phone?: string; company?: string; relationship?: string; notes?: string }) {
	return rpcOrCall('contacts.update', c, () => post('/api/contacts/update', c));
}

export function deleteContact(id: string) {
	return rpcOrCall('contacts.delete', { id }, () => post('/api/contacts/delete', { id }));
}

export function logInteraction(contact_id: string, type: string, summary: string, date?: string) {
	return rpcOrCall('contacts.logInteraction', { contact_id, type, summary, date }, () => post('/api/contacts/log-interaction', { contact_id, type, summary, date }));
}

// ── Leads (CRM pipeline) ───────────────────────────────────────────
export function listLeads(opts: { status?: string; source?: string; limit?: number } = {}) {
	const params = new URLSearchParams();
	if (opts.status) params.set('status', opts.status);
	if (opts.source) params.set('source', opts.source);
	if (opts.limit !== undefined) params.set('limit', String(opts.limit));
	const qs = params.toString();
	return apiFetch(`/api/crm/leads${qs ? '?' + qs : ''}`);
}
export function listLeadSources() {
	return apiFetch('/api/crm/leads/sources');
}
export function setLeadStatus(id: string, status: string) {
	return post('/api/crm/leads/status', { id, status });
}

// ── Reminders ─────────────────────────────────────────────────────
export function dismissReminder(id: string) {
	return rpcOrCall('reminders.dismiss', { id }, () => post('/api/reminders/dismiss', { id }));
}

export function snoozeReminder(id: string, minutes = 30) {
	return rpcOrCall('reminders.snooze', { id, minutes }, () => post('/api/reminders/snooze', { id, minutes }));
}

// ── Shopping ───────────────────────────────────────────────────────
export function checkShoppingItem(itemId: string, checked: boolean) {
	return rpcOrCall('shopping.items.check', { id: itemId, checked }, () => post('/api/shopping/check-item', { id: itemId, checked }));
}

export function addShoppingItem(listId: string, name: string) {
	return rpcOrCall('shopping.items.add', { list_id: listId, name }, () => post('/api/shopping/add-item', { list_id: listId, name }));
}

export function removeShoppingItem(itemId: string) {
	return rpcOrCall('shopping.items.remove', { id: itemId }, () => del('/api/shopping/remove-item?id=' + itemId));
}

export function createShoppingList(name: string) {
	return rpcOrCall('shopping.lists.create', { name }, () => post('/api/shopping/create-list', { name }));
}

export function completeShoppingList(id: string) {
	return rpcOrCall('shopping.lists.complete', { id }, () => post('/api/shopping/complete-list', { id }));
}

export function reopenShoppingList(id: string) {
	return rpcOrCall('shopping.lists.reopen', { id }, () => post('/api/shopping/reopen-list', { id }));
}

// ── Office Kit ─────────────────────────────────────────────────────
/** Create/refresh a whole office (flow + agents + chains + cron + repo) in
 *  one call — consumed by the "New Office" wizard on /agents-flow. */
export function createOffice(def: Record<string, unknown>) {
	return rpcOrCall('offices.create', def, () => post('/api/offices/create', def));
}

// ── Comms ──────────────────────────────────────────────────────────
export function createComm(body: Record<string, unknown>) {
	return rpcOrCall('comms.create', body, () => post('/api/dashboard/comms/create', body));
}

export function sendComm(id: string) {
	return rpcOrCall('comms.send', { id }, () => post('/api/dashboard/comms/send', { id }));
}

export function updateComm(body: Record<string, unknown>) {
	return rpcOrCall('comms.update', body, () => put('/api/dashboard/comms/update', body));
}

export async function searchCommsInbox(query: string) {
	return rpcOrCall('comms.search', { q: query }, () => apiFetch('/api/dashboard/comms/search?q=' + encodeURIComponent(query)));
}

export async function getCommThread(threadId: string) {
	return rpcOrCall('comms.thread', { id: threadId }, () => apiFetch('/api/dashboard/comms/thread?id=' + encodeURIComponent(threadId)));
}

export async function getCommDetail(id: string) {
	return rpcOrCall('comms.detail', { id }, () => apiFetch('/api/dashboard/comms/detail?id=' + encodeURIComponent(id)));
}

// ── Email suggestions ──────────────────────────────────────────────
export function listEmailSuggestions(limit = 50) {
	return rpcOrCall('emailSuggestions.list', { limit }, () => apiFetch('/api/email-suggestions'));
}

export function dismissEmailSuggestion(id: string) {
	return rpcOrCall('emailSuggestions.dismiss', { id }, () => post('/api/email-suggestions/dismiss', { id }));
}

/**
 * Approve a pending suggestion. The HTTP fallback is intentionally a no-op
 * (the legacy /approve endpoint is locked) — approval requires the WS-RPC
 * path with services wired in. If WS is down, we surface that so the user
 * can retry rather than silently failing.
 */
export function approveEmailSuggestion(id: string, overrides: Record<string, unknown> = {}) {
	return rpcOrCall('emailSuggestions.approve', { id, overrides }, async () => {
		throw new Error('approve requires the kernel WS connection — reconnect and retry');
	});
}

// ── Feeds / News ───────────────────────────────────────────────────
export function refreshFeeds() {
	return rpcOrCall('feeds.refresh', {}, () => post('/api/feeds/refresh', {}));
}

export function addFeed(url: string, name: string) {
	return rpcOrCall('feeds.add', { url, name }, () => post('/api/feeds', { url, name }));
}

export function deleteFeed(id: string) {
	return rpcOrCall('feeds.delete', { id }, () => del('/api/feeds/' + id));
}

export function toggleFeed(id: string) {
	return rpcOrCall('feeds.toggle', { id }, () => post('/api/feeds/' + id + '/toggle', {}));
}

// ── Agents ─────────────────────────────────────────────────────────
export function runAgent(id: string) {
	return rpcOrCall('agents.run', { agent_id: id }, () => post('/api/agents/run', { agent_id: id }));
}

export function stopAgent(id: string) {
	return rpcOrCall('agents.stop', { agent_id: id }, () => post('/api/agents/stop', { agent_id: id }));
}

export function updateAgent(id: string, body: Record<string, unknown>) {
	return rpcOrCall('agents.update', { id, ...body }, () => put('/api/agents/' + id, body));
}

export function deleteAgent(id: string) {
	return rpcOrCall('agents.delete', { id }, () => del('/api/agents/' + id));
}

export function createAgent(body: Record<string, unknown>) {
	return rpcOrCall('agents.create', body, () => post('/api/agents', body));
}

export function triggerAgent(body: Record<string, unknown>) {
	return rpcOrCall('agents.trigger', body, () => post('/api/agents/trigger', body));
}

// ── Prompt versions (Autogenesis RSPL) ─────────────────────────────
export function listPromptVersions(agentId: string) {
	return apiFetch('/api/agents/' + agentId + '/prompt-versions');
}

export function getPromptVersion(agentId: string, version: number) {
	return apiFetch('/api/agents/' + agentId + '/prompt-versions/' + version);
}

export function diffPromptVersions(agentId: string, from: number, to: number) {
	return apiFetch('/api/agents/' + agentId + '/prompt-versions/' + from + '/diff/' + to);
}

export function restorePromptVersion(agentId: string, version: number, note = '') {
	return post('/api/agents/' + agentId + '/prompt-versions/' + version + '/restore', { note });
}

export function activatePromptVersion(agentId: string, version: number) {
	return post('/api/agents/' + agentId + '/prompt-versions/' + version + '/activate', {});
}

// ── Evolution (Autogenesis SEPL) ────────────────────────────────────
export function listEvolutionRuns(agentId: string) {
	return apiFetch('/api/agents/' + agentId + '/evolution');
}

export function runEvolutionCycle(agentId: string, opts: Record<string, unknown> = {}) {
	return post('/api/agents/' + agentId + '/evolution/run', opts);
}

export function acceptEvolution(runId: string) {
	return post('/api/agents/evolution/' + runId + '/accept', {});
}

export function rejectEvolution(runId: string) {
	return post('/api/agents/evolution/' + runId + '/reject', {});
}

// ── Skills ─────────────────────────────────────────────────────────
export function enableSkill(id: string) {
	return rpcOrCall('skills.enable', { id }, () => post('/api/skills/enable', { id }));
}

export function disableSkill(id: string) {
	return rpcOrCall('skills.disable', { id }, () => post('/api/skills/disable', { id }));
}

export function uninstallSkill(id: string) {
	return rpcOrCall('skills.uninstall', { id }, () => del('/api/skills/uninstall?id=' + id));
}

export function installSkill(body: Record<string, unknown>) {
	return rpcOrCall('skills.install', body, () => post('/api/skills/install', body));
}

// ── Marketplace ─────────────────────────────────────────────────────
export function marketplaceInstall(id: string) {
	return rpcOrCall('marketplace.install', { id }, () => post('/api/marketplace/install', { id }));
}

export function marketplaceUninstall(id: string) {
	return rpcOrCall('marketplace.uninstall', { id }, () => post('/api/marketplace/uninstall', { id }));
}

export function marketplaceEnable(id: string) {
	return rpcOrCall('marketplace.enable', { id }, () => post('/api/marketplace/enable', { id }));
}

export function marketplaceDisable(id: string) {
	return rpcOrCall('marketplace.disable', { id }, () => post('/api/marketplace/disable', { id }));
}

export function marketplaceReview(item_id: string, rating: number, title?: string, body?: string) {
	return rpcOrCall('marketplace.review', { item_id, rating, title, body }, () => post('/api/marketplace/review', { item_id, rating, title, body }));
}

export function marketplaceActivateTheme(item_id: string) {
	return rpcOrCall('marketplace.theme.activate', { item_id }, () => post('/api/marketplace/theme/activate', { item_id }));
}

export function marketplaceDeactivateTheme() {
	return rpcOrCall('marketplace.theme.deactivate', {}, () => post('/api/marketplace/theme/deactivate', {}));
}

export function marketplaceImport(pkg: Record<string, unknown>) {
	return rpcOrCall('marketplace.import', pkg, () => post('/api/marketplace/import', pkg));
}

export async function marketplaceExport(id: string) {
	return rpcOrCall('marketplace.export', { id }, () => apiFetch('/api/marketplace/export/' + id));
}

// ── Chat ───────────────────────────────────────────────────────────
export async function getChatEpisodes() {
	const res: any = await rpcOrCall('chat.episodes.list', {}, () => apiFetch('/api/chat/episodes'));
	// WS RPC returns { episodes: [...] }, HTTP may return array directly
	return Array.isArray(res) ? res : (res?.episodes ?? []);
}

export async function getChatMessages(episodeId: string) {
	const res: any = await rpcOrCall('chat.messages.list', { episode_id: episodeId }, () => apiFetch('/api/chat/messages?episode_id=' + encodeURIComponent(episodeId)));
	return Array.isArray(res) ? res : (res?.messages ?? []);
}

export async function startChatEpisode(input: {
	title?: string;
	provider?: string;
	model?: string;
	instructions?: string;
} = {}) {
	const res: any = await rpcOrCall(
		'chat.episode.start',
		input,
		() => post('/api/chat/start', input),
	);
	// WS RPC returns { ok: true, episode }, HTTP returns episode directly
	return res?.episode ?? res;
}

export function sendChatMessage(body: Record<string, unknown>) {
	return rpcOrCall('chat.message.send', body, () => post('/api/chat/message', body));
}

// ── Streaming chat ────────────────────────────────────────────────
// One event per SSE block — typed loosely so the dashboard branches on
// `.type` and the kernel can add new event kinds without breaking older
// frontends.
export type ChatStreamEvent =
	| { type: 'assistant_text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
	| {
			type: 'permission_request';
			request_id: string;
			tool_name: string;
			input: Record<string, unknown>;
	  }
	| { type: 'system'; subtype: string; data: Record<string, unknown> }
	| { type: 'session'; session_id: string }
	| {
			type: 'done';
			final_text: string;
			tokens_used: number;
			stop_reason?: string;
			message_id: string;
	  }
	| { type: 'error'; message: string };

/**
 * POST + SSE — calls the kernel's streaming chat endpoint and yields each
 * decoded event. Caller drives a `for await` loop and renders deltas live.
 * Aborts when `signal` is triggered (route teardown, user navigates away).
 */
export async function* sendChatMessageStream(
	body: {
		episode_id: string;
		message: string;
		allowed_tools?: string[];
		disallowed_tools?: string[];
		/** Ignore host user settings (plugins / user MCPs) — built-ins + kernel MCP only. */
		isolate_settings?: boolean;
	},
	signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent, void, unknown> {
	const token = getAuthToken();
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'text/event-stream',
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const r = await fetch('/api/chat/message/stream', {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal,
	});
	if (!r.ok || !r.body) {
		const err = await r
			.json()
			.catch(() => ({ error: r.statusText }))
			.then((j: { error?: string }) => j.error || r.statusText);
		throw new Error(err);
	}

	const reader = r.body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		// SSE blocks are separated by a blank line. Parse one block at a time.
		let sep: number;
		while ((sep = buffer.indexOf('\n\n')) !== -1) {
			const block = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			// Skip heartbeats (": ping").
			if (!block || block.startsWith(':')) continue;
			let data = '';
			for (const line of block.split('\n')) {
				if (line.startsWith('data:')) data += line.slice(5).trimStart();
			}
			if (!data) continue;
			try {
				yield JSON.parse(data) as ChatStreamEvent;
			} catch {
				/* malformed event — ignore */
			}
		}
	}
}

export function respondChatPermission(
	request_id: string,
	behavior: 'allow' | 'deny',
	reason?: string,
) {
	return post('/api/chat/permission/respond', { request_id, behavior, reason });
}

// ── Memory / distilled facts ────────────────────────────────────────
// Surfaces the rows written by the chat session-end memory distiller.
// Used by the /memory dashboard page.

export interface DistilledFact {
	id: string;
	episode_id: string;
	category: string;
	fact: string;
	confidence: number;
	created_at: string;
}

export interface DistilledSummary {
	categories: Array<{ category: string; count: number; latest: string }>;
	total: number;
}

export async function getDistilledFacts(opts: { category?: string; limit?: number } = {}): Promise<DistilledFact[]> {
	const params = new URLSearchParams();
	if (opts.category) params.set('category', opts.category);
	if (opts.limit) params.set('limit', String(opts.limit));
	const qs = params.toString() ? '?' + params.toString() : '';
	const res = (await apiFetch('/api/chat/distilled-facts' + qs)) as { facts?: DistilledFact[] };
	return res?.facts ?? [];
}

export async function getDistilledFactsForEpisode(episodeId: string): Promise<DistilledFact[]> {
	const res = (await apiFetch(
		'/api/chat/distilled-facts/episode?episode_id=' + encodeURIComponent(episodeId),
	)) as { facts?: DistilledFact[] };
	return res?.facts ?? [];
}

export async function getDistilledSummary(): Promise<DistilledSummary> {
	const res = (await apiFetch('/api/chat/distilled-facts/summary')) as DistilledSummary;
	return { categories: res?.categories ?? [], total: res?.total ?? 0 };
}

// ── AI Config ──────────────────────────────────────────────────────
export function saveAiConfig(body: Record<string, unknown>) {
	return rpcOrCall('config.ai.save', body, () => post('/api/config/ai', body));
}

// ── Google ─────────────────────────────────────────────────────────
export function startGoogleAuth() {
	return rpcOrCall('google.auth.start', {}, () => post('/api/google/auth/start', {}));
}

// Live Google/Gmail connection health: { status, needsReauth, authUrl, ... }.
// Surfaces a dead refresh token (needs_reauth) so the UI can prompt a reconnect.
export function fetchGoogleSyncStatus() {
	return rpcOrCall('google.status', {}, () => apiFetch('/api/email-accounts/google-profile'));
}

export function revokeGoogleAuth() {
	return rpcOrCall('google.auth.revoke', {}, () => post('/api/google/revoke', {}));
}

// ── PII status ─────────────────────────────────────────────────────
export async function getPiiStatus() {
	return rpcOrCall('pii.status', {}, () => apiFetch('/api/pii/status'));
}

// ── Office infrastructure (per-flow virtual environment) ──────────────
export interface OfficeEnvStatus {
	flow_id: string;
	state: 'absent' | 'created' | 'running' | 'paused' | 'exited' | 'error';
	image: string;
	container_name: string;
	preview_url: string | null;
	desired_state: 'stopped' | 'running' | 'paused';
	last_error: string;
}
export interface OfficeEnvConfig {
	flow_id: string;
	image: string;
	container_name: string;
	workspace_subpath: string;
	ports_json: string;
	env_json: string;
	network: string;
	run_command: string;
	desired_state: string;
}

export async function getOfficeEnv(flowId: string): Promise<{ config: OfficeEnvConfig; status: OfficeEnvStatus }> {
	return apiFetch('/api/office-env?flow_id=' + encodeURIComponent(flowId)) as Promise<{ config: OfficeEnvConfig; status: OfficeEnvStatus }>;
}

export async function configureOfficeEnv(
	flowId: string,
	patch: { image?: string; ports?: string[]; env?: Record<string, string>; network?: string; run_command?: string; workspace_subpath?: string },
): Promise<{ config: OfficeEnvConfig; status: OfficeEnvStatus }> {
	return post('/api/office-env/configure', { flow_id: flowId, ...patch }) as Promise<{ config: OfficeEnvConfig; status: OfficeEnvStatus }>;
}

export async function officeEnvAction(
	action: 'up' | 'pause' | 'resume' | 'stop' | 'restart' | 'status',
	flowId: string,
): Promise<{ status: OfficeEnvStatus }> {
	return post('/api/office-env/' + action, { flow_id: flowId }) as Promise<{ status: OfficeEnvStatus }>;
}

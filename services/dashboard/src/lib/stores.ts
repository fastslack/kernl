import { writable } from 'svelte/store';

// Server config — initial value is overridden by the /api/health response.
export const serverTz = writable('UTC');

// Core data stores — populated by WS messages and HTTP fetches
export const data = writable<Record<string, unknown> | null>(null);
export const analytics = writable<Record<string, unknown> | null>(null);
export const issues = writable<Record<string, unknown> | null>(null);
export const automations = writable<Record<string, unknown> | null>(null);
export const crossIntel = writable<Record<string, unknown> | null>(null);
export const life = writable<Record<string, unknown> | null>(null);
export const comms = writable<Record<string, unknown> | null>(null);
export const house = writable<Record<string, unknown> | null>(null);
export const planner = writable<Record<string, unknown> | null>(null);
export const systemAgenda = writable<Record<string, unknown> | null>(null);
export const chat = writable<Record<string, unknown> | null>(null);
export const agents = writable<Record<string, unknown> | null>(null);
export const skills = writable<Record<string, unknown> | null>(null);
export const marketplace = writable<Record<string, unknown> | null>(null);
export const aiConfig = writable<Record<string, unknown> | null>(null);
export const google = writable<Record<string, unknown> | null>(null);
export const finance = writable<Record<string, unknown> | null>(null);
export const subscriptions = writable<Record<string, unknown> | null>(null);
export const healthData = writable<Record<string, unknown> | null>(null);
export const training = writable<Record<string, unknown> | null>(null);
export const nutrition = writable<Record<string, unknown> | null>(null);
export const news = writable<Record<string, unknown> | null>(null);
export const apiRegistry = writable<Record<string, unknown> | null>(null);
export const rssRegistry = writable<Record<string, unknown> | null>(null);
export const rssReader = writable<Record<string, unknown> | null>(null);
export const files = writable<Record<string, unknown> | null>(null);

// Active theme (fetched from marketplace)
export interface ActiveTheme {
	name: string;
	slug: string;
	icon: string;
	variables: Record<string, string>;
	fonts: string[];
	customCss: string;
	previewColors: string[];
}
export const activeTheme = writable<ActiveTheme | null>(null);

// Dashboard notifications
export interface DashboardNotification {
	id: string;
	title: string;
	body: string;
	priority: 'low' | 'normal' | 'high';
	source: string;
	read: number;
	created_at: string;
}
export const notifications = writable<DashboardNotification[]>([]);
export const unreadCount = writable(0);

// Agent flow real-time events
export interface AgentFlowEvent {
	event: string;
	data: Record<string, unknown>;
	ts: string;
}
export const agentFlowEvents = writable<AgentFlowEvent[]>([]);

// Architecture real-time events (for 3D map)
export interface ArchEvent {
	event: string;
	data: Record<string, unknown>;
	ts: string;
}
export const archEvents = writable<ArchEvent[]>([]);

// UI state
export const wsConnected = writable(false);
export const lastRefresh = writable<Date | null>(null);

// All stores in a map for WS channel routing
export const storeMap: Record<string, ReturnType<typeof writable>> = {
	data,
	analytics,
	issues,
	automations,
	crossIntel,
	life,
	comms,
	house,
	planner,
	systemAgenda,
	chat,
	agents,
	skills,
	marketplace,
	aiConfig,
	google,
	finance,
	subscriptions,
	healthData,
	training,
	nutrition,
	news,
	apiRegistry,
	rssRegistry,
	rssReader,
	files
};

/** Get or create a store by name — makes storeMap extensible at runtime */
export function ensureStore(name: string): ReturnType<typeof writable> {
	if (!(name in storeMap)) {
		storeMap[name] = writable<Record<string, unknown> | null>(null);
	}
	return storeMap[name];
}

// Bulk update all stores from a full fetch
export function setAllStores(d: Record<string, unknown>) {
	for (const [key, val] of Object.entries(d)) {
		if (key in storeMap) {
			storeMap[key].set(val as Record<string, unknown>);
		}
	}
}

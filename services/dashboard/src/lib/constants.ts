// Colors and constants from app.html

export const COMM_STATUS_COL: Record<string, string> = {
	draft: 'var(--gold)',
	ready: 'var(--green)',
	sending: 'var(--blue)',
	sent: 'var(--green)',
	failed: 'var(--red)',
	archived: 'var(--text-2)'
};

export const CHAN_COL: Record<string, string> = {
	email: 'var(--blue)',
	whatsapp: 'var(--green)',
	mattermost: 'var(--purple)',
	x: 'var(--text-1)',
	instagram: 'var(--orange)',
	linkedin: 'var(--blue)'
};

export const TL_COLORS: Record<string, string> = {
	task: '#5B9BF7', reminder: '#F0883E', subscription: '#3DD68C',
	health: '#F04770', maintenance: '#D4A84B', vehicle: '#D4A84B',
	document: '#6E738A', goal: '#3DD6C8', meal: '#da7756',
	research: '#8B7CF6', event: '#E879A8', cache: '#6E738A',
	interval: '#3DD6C8', watcher: '#D4A84B', listener: '#F0883E',
	automation: '#8B7CF6'
};

export const FREQ_COLORS: Record<string, string> = {
	'real-time': '#6E738A', 'hourly': '#3DD68C', '6h': '#3DD6C8',
	'12h': '#D4A84B', 'daily': '#5B9BF7', 'weekly': '#8B7CF6'
};

export const FREQ_ORDER = ['real-time', 'hourly', '6h', '12h', 'daily', 'weekly'];

export const TL_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export interface NavView {
	id: string;
	label: string;
	icon: string;
	/** Sub-tab relationship: if set, this view renders as a child tab of `parent`. */
	parent?: string;
	/** Order within its group. Lower = leftmost. */
	order?: number;
}

export interface NavGroup {
	id: string;
	label: string;
	icon: string;
	views: NavView[];
	defaultView?: string;
	order?: number;
}

/**
 * NAV_GROUPS is now almost entirely extension-driven.
 *
 * Only two hardcoded survivors:
 *   - `people` group — kept because Chat lives here and must never disappear.
 *   - `system` group — core admin surface (Settings, Extensions, etc.).
 *
 * Everything else — Home, Work, Finance, Wellness, AI, Tools — comes from
 * extensions declaring `frontend.navGroups` + `frontend.navItems` in their
 * manifest. See the concrete stubs under `assets/extensions/SLUG/`
 * (home, news, life, shopping-nav, house,
 *  work-suite, people-suite, finance-suite, wellness-suite, ai-suite,
 *  filesystem-commander). Disable any of them from /extensions and their
 * items/groups vanish from the sidebar.
 */
export const NAV_GROUPS: NavGroup[] = [
	{
		// `id` stays 'people' so all extension navItems with
		// `group: "people"` keep wiring up correctly. Only the visible
		// label/icon change — renaming the id would orphan every tab.
		id: 'people',
		label: 'Social',
		icon: '🌐',
		views: [
			// Explicit order — items without one sort to 999 and land after
			// every manifest-contributed tab regardless of intent.
			{ id: 'irc', label: 'IRC', icon: '📡', order: 60 }
		]
	},
	{
		id: 'system',
		label: 'System',
		icon: '⚙️',
		// Cuatro tabs arriba, el resto en el rail lateral de /system.
		// Los items con `parent` quedan fuera de la barra de grupo por el
		// filtro de `subViews` en +layout.svelte y los recoge `railViewsFor`.
		views: [
			{ id: 'settings', label: 'Settings', icon: '⚙️', order: 10 },
			{ id: 'system', label: 'System', icon: '🖥️', order: 20 },
			{ id: 'extensions', label: 'Extensions', icon: '🧩', order: 30 },
			{ id: 'notifications', label: 'Notifs', icon: '🔔', order: 40 },
			// Rail de /system. Las extensiones se cuelgan acá declarando
			// `parent: "system"` en su manifiesto (rss-registry, cloudflare).
			{ id: 'architecture', label: 'Arch 3D', icon: '🧊', parent: 'system', order: 20 },
			{ id: 'friends', label: 'Friends', icon: '🤝', parent: 'system', order: 30 },
			// El label acá es solo fallback: `viewLabel` prefiere la clave i18n
			// `nav.view.api-registry`, que existe en en y es. Lo dejamos igual
			// para que el código no diga una cosa y la pantalla otra.
			{ id: 'api-registry', label: 'API Registry', icon: '🔌', parent: 'system', order: 40 }
		]
	}
];

// Short labels for sub-tabs (matching vanilla app)
export const SUB_TAB_LABELS: Record<string, string> = {
	home: 'Overview', news: 'News', life: 'Life', shopping: 'Shop', house: 'House',
	work: 'Overview', tasks: 'Tasks', planner: 'Planner', issues: 'Issues', reminders: 'Alerts',
	crm: 'Overview', people: 'Contacts', mail: 'Mail', comms: 'Comms', chat: 'Chat', 'x-manager': 'X', irc: 'IRC',
	finance: 'Overview', subscriptions: 'Subscriptions',
	wellness: 'Overview', health: 'Health', training: 'Training', nutrition: 'Nutrition',
	// `skills` has no tab any more — it redirects into /extensions?tab=skills.
	// The label stays so the breadcrumb reads sanely during the redirect.
	'ai-overview': 'Overview', agents: 'Agents', 'agents-flow': '3D', autogenesis: 'Evolutions', ranks: 'Ranks', workspace: 'Workspace', skills: 'Skills', marketplace: 'Store',
	cinema: 'Cinema',
	books: 'Books',
	music: 'Music',
	repos: 'Repos',
	settings: 'Settings', system: 'System', extensions: 'Extensions', notifications: 'Notifications',
	// Rutas de sistema fuera de la tab bar, alcanzadas desde el rail de /system:
	architecture: 'Arch 3D', friends: 'Friends',
	'api-registry': 'API Registry', 'rss-registry': 'RSS Feeds'
};

export const VIEWS: NavView[] = NAV_GROUPS.flatMap(g => g.views);

// view id → group **id**. Keying on the label instead was a latent bug: the
// layout looks the result up with `navGroups.find(g => g.id === ...)`, and the
// people group's label ('Social') matches no id, so before the manifest lands
// no rail item highlighted at all.
export const VIEW_TO_GROUP: Record<string, string> = {};
for (const g of NAV_GROUPS) {
	for (const v of g.views) {
		VIEW_TO_GROUP[v.id] = g.id;
	}
}

/** Core WS channel → store mappings. Module-specific mappings come from /api/manifest */
export const WS_CHANNEL_MAP: Record<string, string> = {
	dashboard: 'data',
	analytics: 'analytics',
	agenda: 'automations',
	crossIntel: 'crossIntel',
	life: 'life',
	calendar: 'planner',
	systemAgenda: 'systemAgenda',
	agents: 'agents',
	notifications: 'notifications',
	finance: 'finance',
	health: 'healthData',
	notes: 'notes',
	learning: 'learning',
};

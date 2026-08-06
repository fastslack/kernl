// Colors and constants from app.html

export const COL: Record<string, string> = {
	KNOWS: 'var(--teal)',
	SAME_DOMAIN: 'var(--blue)',
	SAME_COMPANY: 'var(--purple)',
	DEPENDS_ON: 'var(--gold)'
};

export const CC: string[] = [
	'var(--teal)', 'var(--blue)', 'var(--purple)', 'var(--gold)',
	'var(--green)', 'var(--orange)', 'var(--red)'
];

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
export const TL_DOWS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

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
 * (home, news, life, shopping-nav, house, files-indexer,
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
			{ id: 'irc', label: 'IRC', icon: '📡' }
		]
	},
	{
		id: 'system',
		label: 'System',
		icon: '⚙️',
		// Slimmed to 4 tabs. The routes for sysoverview / architecture /
		// providers / api-registry / rss-registry still exist — sysoverview
		// and architecture are reachable via the internal sub-nav on
		// /system, the rest via direct URL or in-page links.
		views: [
			{ id: 'settings', label: 'Settings', icon: '⚙️' },
			{ id: 'system', label: 'System', icon: '🖥️' },
			{ id: 'extensions', label: 'Extensions', icon: '🧩' },
			{ id: 'notifications', label: 'Notifs', icon: '🔔' }
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
	'ai-overview': 'Overview', agents: 'Agents', 'agents-flow': 'Flow', autogenesis: 'Evolutions', ranks: 'Ranks', models: 'Models', workspace: 'Workspace', skills: 'Skills', marketplace: 'Store',
	cinema: 'Cinema',
	books: 'Books',
	music: 'Music',
	automations: 'Automation',
	settings: 'Settings', system: 'System', extensions: 'Extensions', notifications: 'Notifications',
	// Off-tab system routes (still routable, linked from /system sub-nav):
	sysoverview: 'Overview', architecture: 'Arch 3D', providers: 'AI Providers', friends: 'Friends',
	'api-registry': 'API Registry', 'rss-registry': 'RSS Feeds'
};

export const VIEWS: NavView[] = NAV_GROUPS.flatMap(g => g.views);

export const VIEW_TO_GROUP: Record<string, string> = {};
for (const g of NAV_GROUPS) {
	for (const v of g.views) {
		VIEW_TO_GROUP[v.id] = g.label.toLowerCase();
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

export const AI_PROVIDERS = [
	{
		id: 'anthropic',
		name: 'Anthropic Claude',
		icon: '🧠',
		tagline: 'Best for reasoning, agentic workflows, and tool use',
		description: 'Claude is the primary AI engine powering agents, chat, and web intelligence in Kernl.',
		keyLabel: 'API Key',
		keyField: 'anthropicApiKey',
		keyPlaceholder: 'sk-ant-api03-…',
		getKeyUrl: 'https://console.anthropic.com/keys',
		getKeyLabel: 'Get key at console.anthropic.com',
		models: ['claude-sonnet-4-20250514','claude-opus-4-5','claude-3-5-haiku-20241022','claude-3-5-sonnet-20241022'],
		supportsTools: true,
		color: 'var(--gold)'
	},
	{
		id: 'claude_code',
		name: 'Claude Code',
		icon: '🤖',
		tagline: 'Claude Agent SDK — built-in Bash/Read/Edit/Write/Grep + MCPs, propio cwd sandbox',
		description: 'Runs the agent with the Claude Agent SDK (the same engine as the Claude Code CLI). Supports a Max subscription via OAuth, or an API key. No multi-provider fallback — picking this clears the model chain.',
		keyLabel: 'API Key',
		keyField: 'anthropicApiKey',
		keyPlaceholder: 'sk-ant-api03-… (o usá tu sub vía OAuth)',
		getKeyUrl: 'https://console.anthropic.com/keys',
		getKeyLabel: 'Usa tu Claude Max sub o api key',
		models: ['claude-opus-4-7','claude-opus-4-6','claude-sonnet-4-6','claude-haiku-4-5'],
		supportsTools: true,
		color: 'var(--blue)'
	},
	{
		id: 'openai',
		name: 'OpenAI',
		icon: '⚡',
		tagline: 'GPT models for chat, voice (STT/TTS), and fallback',
		description: 'OpenAI powers voice transcription (Whisper), text-to-speech, and chat fallback.',
		keyLabel: 'API Key',
		keyField: 'openaiApiKey',
		keyPlaceholder: 'sk-proj-…',
		getKeyUrl: 'https://platform.openai.com/api-keys',
		getKeyLabel: 'Get key at platform.openai.com',
		models: ['gpt-4o','gpt-4o-mini','gpt-4-turbo','gpt-3.5-turbo'],
		supportsTools: true,
		color: 'var(--green)'
	},
	{
		id: 'grok',
		name: 'xAI Grok',
		icon: '𝕏',
		tagline: 'Grok models from xAI — OpenAI-compatible, fast, long context',
		description: 'xAI Grok is an OpenAI-compatible endpoint (api.x.ai/v1). Use it as a primary provider or as fallback when other providers hit their quota.',
		keyLabel: 'API Key',
		keyField: 'grokApiKey',
		keyPlaceholder: 'xai-…',
		getKeyUrl: 'https://console.x.ai',
		getKeyLabel: 'Get key at console.x.ai',
		models: [
			'grok-4.20-0309-reasoning',
			'grok-4.20-0309-non-reasoning',
			'grok-4.20-multi-agent-0309',
			'grok-4-1-fast-reasoning',
			'grok-4-1-fast-non-reasoning',
			'grok-4-fast-reasoning',
			'grok-4-fast-non-reasoning',
			'grok-4-0709',
			'grok-code-fast-1',
			'grok-3',
			'grok-3-mini',
		],
		supportsTools: true,
		color: 'var(--blue)'
	},
	{
		id: 'minimax',
		name: 'MiniMax',
		icon: '🅼',
		tagline: 'MiniMax M-series — OpenAI-compatible, long context, agentic',
		description: 'MiniMax is an OpenAI-compatible endpoint (api.minimax.io/v1). Use it as a primary provider or as fallback. Registry-native provider — its config lives in the LLM provider registry.',
		keyLabel: 'API Key',
		keyField: 'minimaxApiKey',
		keyPlaceholder: 'eyJ…',
		getKeyUrl: 'https://www.minimax.io/platform',
		getKeyLabel: 'Get key at minimax.io',
		models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2'],
		supportsTools: true,
		color: 'var(--red)'
	},
	{
		id: 'lmstudio',
		name: 'LM Studio',
		icon: '🏠',
		tagline: '100% local, no API key needed — OpenAI-compatible server',
		description: 'Run any GGUF model locally with LM Studio. No API key required — just start the local server. Models are auto-detected.',
		keyLabel: 'Base URL',
		keyField: 'lmstudioBaseUrl',
		keyPlaceholder: 'http://localhost:1234/v1',
		getKeyUrl: 'https://lmstudio.ai',
		getKeyLabel: 'Download LM Studio — lmstudio.ai',
		models: [],
		supportsTools: true,
		color: 'var(--teal)'
	},
	{
		id: 'elevenlabs',
		name: 'ElevenLabs',
		icon: '🎙️',
		tagline: 'High-quality text-to-speech for voice responses',
		description: 'ElevenLabs provides ultra-realistic AI voices for TTS when voice is enabled.',
		keyLabel: 'API Key',
		keyField: 'elevenLabsApiKey',
		keyPlaceholder: 'sk_…',
		getKeyUrl: 'https://elevenlabs.io/sign-up',
		getKeyLabel: 'Get key at elevenlabs.io',
		models: [],
		supportsTools: false,
		color: 'var(--purple)'
	}
];

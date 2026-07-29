<!--
  Host Integrations — per-agent scoping of skills, plugins, MCPs and plugin
  marketplaces shipped by the host (via ~/.claude/*). Formerly the dedicated
  /agent-extensions page; now embedded as a tab inside /extensions so everything
  extension-related lives in one place.
-->
<script lang="ts">
  import { onMount } from 'svelte';

  type Skill = { name: string; source: 'user' | 'plugin'; plugin?: string; marketplace?: string; description: string; path: string };
  type Plugin = { name: string; marketplace: string; path: string; description: string; provides: { skills: string[]; agents: string[]; commands: string[] } };
  type Mcp = { name: string; source: string; type: string; description: string };
  type Agent = { id: string; name: string; flow_id?: string; executor_type?: string; variables?: string };
  type Marketplace = { id: string; name: string; title: string; description: string; git_url: string; last_commit: string; plugin_count: number; path: string };

  let extensions: { skills: Skill[]; plugins: Plugin[]; mcps: Mcp[]; counts: { skills: number; plugins: number; mcps: number } } | null = null;
  let marketplaces: Marketplace[] = [];
  let agents: Agent[] = [];
  let selectedAgentId = '';
  let tab: 'skills' | 'plugins' | 'mcps' | 'marketplaces' = 'skills';
  let loading = true;
  let error = '';
  let toasts: Array<{ id: number; kind: 'ok' | 'err'; title: string; detail?: string }> = [];
  let toastSeq = 0;
  const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  let inflight = false;
  let mpBusy: Record<string, boolean> = {};
  let addUrl = '';
  let addBusy = false;

  // Claude Code canonical host config (~/.claude.json + ~/.claude/settings.json)
  type UserScopeConfig = {
    hostHome: string;
    mcpServers: Record<string, any>;
    enabledPlugins: Record<string, boolean>;
    extraKnownMarketplaces: Record<string, unknown>;
  };
  let claudeConfig: UserScopeConfig | null = null;

  async function load() {
    loading = true;
    try {
      const [extRes, agRes, mpRes, ccRes] = await Promise.all([
        fetch('/api/agents/extensions').then(r => r.json()),
        fetch('/api/agents').then(r => r.json()),
        fetch('/api/agents/marketplaces').then(r => r.json()),
        fetch('/api/claude-config').then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      extensions = extRes;
      // Only agents that actually run the Claude Agent SDK.
      // An agent with a builtin_handler is a kernel JS script — it never touches
      // the SDK, loads no plugins/skills/MCPs, and has no use for this UI.
      agents = (agRes.agents ?? []).filter((a: any) =>
        a.executor_type === 'claude_code' && !a.builtin_handler
      );
      if (!selectedAgentId && agents.length > 0) selectedAgentId = agents[0].id;
      marketplaces = mpRes.marketplaces ?? [];
      claudeConfig = ccRes;
    } catch (e) {
      error = `Error loading: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      loading = false;
    }
  }

  // ── User-scope MCP actions ─────────────────────────────────────

  async function addUserScopeMcp(entry: {
    name: string;
    type: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  }) {
    try {
      const res = await fetch('/api/claude-config/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      pushToast('ok', 'MCP agregado (user scope)', entry.name);
      // Refresh the canonical config so the UI reflects it
      const ccRes = await fetch('/api/claude-config').then(r => r.ok ? r.json() : null);
      claudeConfig = ccRes;
    } catch (e) {
      pushToast('err', 'Could not add user-scope MCP', e instanceof Error ? e.message : String(e));
    }
  }

  async function removeUserScopeMcp(name: string) {
    if (!confirm(`Remove "${name}" from user scope? This affects EVERY claude_code agent on the host.`)) return;
    try {
      const res = await fetch(`/api/claude-config/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      pushToast('ok', 'MCP removido (user scope)', name);
      const ccRes = await fetch('/api/claude-config').then(r => r.ok ? r.json() : null);
      claudeConfig = ccRes;
    } catch (e) {
      pushToast('err', 'Could not remove', e instanceof Error ? e.message : String(e));
    }
  }

  // ── User-scope Plugin actions ──────────────────────────────────

  async function setUserScopePluginEnabled(ref: string, enabled: boolean) {
    try {
      const path = enabled ? 'enable' : 'disable';
      const res = await fetch(`/api/claude-config/plugin/${encodeURIComponent(ref)}/${path}`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      pushToast('ok', `Plugin ${enabled ? 'enabled' : 'disabled'}`, ref);
      const ccRes = await fetch('/api/claude-config').then(r => r.ok ? r.json() : null);
      claudeConfig = ccRes;
    } catch (e) {
      pushToast('err', 'No se pudo togglear plugin', e instanceof Error ? e.message : String(e));
    }
  }

  async function addMarketplace() {
    if (!addUrl.trim()) return;
    addBusy = true;
    try {
      const res = await fetch('/api/agents/marketplaces', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: addUrl.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      pushToast('ok', 'Marketplace clonado', body.name);
      addUrl = '';
      await load();
    } catch (e) {
      pushToast('err', 'No se pudo clonar', e instanceof Error ? e.message : String(e));
    } finally {
      addBusy = false;
    }
  }

  async function refreshMarketplace(name: string) {
    mpBusy = { ...mpBusy, [name]: true };
    try {
      const res = await fetch(`/api/agents/marketplaces/${encodeURIComponent(name)}/refresh`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      pushToast('ok', 'git pull OK', name);
      await load();
    } catch (e) {
      pushToast('err', 'git pull falló', e instanceof Error ? e.message : String(e));
    } finally {
      const next = { ...mpBusy }; delete next[name]; mpBusy = next;
    }
  }

  async function removeMarketplace(name: string) {
    if (!confirm(`Delete marketplace "${name}" and all of its plugins?`)) return;
    mpBusy = { ...mpBusy, [name]: true };
    try {
      const res = await fetch(`/api/agents/marketplaces/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      pushToast('ok', 'Marketplace removido', name);
      await load();
    } catch (e) {
      pushToast('err', 'Could not delete', e instanceof Error ? e.message : String(e));
    } finally {
      const next = { ...mpBusy }; delete next[name]; mpBusy = next;
    }
  }

  onMount(load);

  $: selectedAgent = agents.find(a => a.id === selectedAgentId);

  $: agentVars = (() => {
    if (!selectedAgent?.variables) return { skills: [] as string[], plugins: [] as string[], mcpServers: {} as Record<string, any>, settingsMode: 'inherit' as 'inherit' | 'isolate' };
    try {
      const raw = JSON.parse(selectedAgent.variables) as Record<string, unknown>;
      const unpack = <T,>(k: string, fallback: T): T => {
        const v = raw[k];
        if (v == null) return fallback;
        if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return fallback; } }
        return v as T;
      };
      const mode = raw.__settings_mode__;
      return {
        skills: unpack<string[]>('__skills__', []),
        plugins: unpack<string[]>('__plugins__', []),
        mcpServers: unpack<Record<string, any>>('__mcp_servers__', {}),
        settingsMode: (mode === 'isolate' ? 'isolate' : 'inherit') as 'inherit' | 'isolate',
      };
    } catch {
      return { skills: [], plugins: [], mcpServers: {}, settingsMode: 'inherit' as const };
    }
  })();

  function pushToast(kind: 'ok' | 'err', title: string, detail?: string) {
    const id = ++toastSeq;
    toasts = [...toasts, { id, kind, title, detail }];
    setTimeout(() => toasts = toasts.filter(t => t.id !== id), kind === 'ok' ? 2500 : 5000);
  }

  async function saveVars(patch: Partial<{ skills: string[]; plugins: string[]; mcpServers: Record<string, unknown>; settingsMode: 'inherit' | 'isolate' }>) {
    if (!selectedAgent) return;
    inflight = true;
    try {
      const raw = selectedAgent.variables ? JSON.parse(selectedAgent.variables) as Record<string, unknown> : {};
      const nextSkills = patch.skills ?? agentVars.skills;
      const nextPlugins = patch.plugins ?? agentVars.plugins;
      const nextMcps = patch.mcpServers ?? agentVars.mcpServers;
      const nextMode = patch.settingsMode ?? agentVars.settingsMode;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k === '__skills__' || k === '__plugins__' || k === '__mcp_servers__' || k === '__settings_mode__') continue;
        next[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      next.__skills__ = JSON.stringify(nextSkills);
      next.__plugins__ = JSON.stringify(nextPlugins);
      next.__mcp_servers__ = JSON.stringify(nextMcps);
      // __settings_mode__ is a plain string, not JSON-encoded — simpler for the executor.
      next.__settings_mode__ = nextMode;

      const res = await fetch(`/api/agents/${selectedAgent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? res.statusText);
      }
      const updated = await res.json();
      agents = agents.map(a => a.id === selectedAgent!.id ? { ...a, variables: updated.agent?.variables ?? a.variables } : a);
      pushToast('ok', 'Guardado', selectedAgent.name);
    } catch (e) {
      pushToast('err', 'Error saving', e instanceof Error ? e.message : String(e));
    } finally {
      inflight = false;
    }
  }

  // ── Agent isolation controls ─────────────────────────────────────

  function setSettingsMode(mode: 'inherit' | 'isolate') {
    if (mode === agentVars.settingsMode) return;
    if (mode === 'isolate' && !confirm(
      'Isolate this agent?\n\n' +
      'The agent will IGNORE all user-scope config ' +
      '(~/.claude.json, ~/.claude/settings.json).\n' +
      'It will only see the MCPs/plugins you defined here for it.\n\n' +
      'Confirm?'
    )) return;
    scheduleSave({ settingsMode: mode });
  }

  async function copyUserScopeToAgent() {
    if (!selectedAgent || !claudeConfig) return;
    const userMcps = claudeConfig.mcpServers ?? {};
    const userPlugins = Object.entries(claudeConfig.enabledPlugins ?? {})
      .filter(([, enabled]) => enabled)
      .map(([ref]) => {
        // enabledPlugins keys are "plugin@marketplace"; our __plugins__ uses "marketplace/plugin"
        const at = ref.lastIndexOf('@');
        if (at < 0) return ref;
        const name = ref.slice(0, at);
        const marketplace = ref.slice(at + 1);
        return `${marketplace}/${name}`;
      });
    const mergedMcps = { ...userMcps, ...agentVars.mcpServers }; // agent wins on conflict
    const mergedPlugins = Array.from(new Set([...userPlugins, ...agentVars.plugins]));
    const mcpCount = Object.keys(userMcps).length;
    const plugCount = userPlugins.length;
    if (!confirm(
      `Copy user-scope config to "${selectedAgent.name}"?\n\n` +
      `About to add:\n` +
      `  • ${mcpCount} MCPs\n` +
      `  • ${plugCount} plugins\n\n` +
      `The agent's existing config is KEPT (the agent wins on collisions).`
    )) return;
    scheduleSave({ mcpServers: mergedMcps, plugins: mergedPlugins });
  }

  function scheduleSave(patch: Partial<{ skills: string[]; plugins: string[]; mcpServers: Record<string, unknown> }>) {
    const key = Object.keys(patch)[0] ?? 'all';
    if (saveTimers[key]) clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(() => {
      delete saveTimers[key];
      saveVars(patch);
    }, 350);
  }

  function toggleSkill(name: string) {
    const cur = agentVars.skills;
    const next = cur.includes(name) ? cur.filter(s => s !== name) : [...cur, name];
    scheduleSave({ skills: next });
  }
  function togglePlugin(ref: string) {
    const cur = agentVars.plugins;
    const next = cur.includes(ref) ? cur.filter(p => p !== ref) : [...cur, ref];
    scheduleSave({ plugins: next });
  }
  function toggleMcp(name: string, cfg: Mcp) {
    const cur = agentVars.mcpServers;
    const next = { ...cur };
    if (next[name]) { delete next[name]; }
    else {
      if (name === 'kernl') next[name] = { type: 'http', url: 'http://host.docker.internal:3086/mcp' };
      else if (cfg.type === 'http') next[name] = { type: 'http', url: '' };
      else next[name] = { type: 'stdio', command: '', args: [] };
    }
    scheduleSave({ mcpServers: next });
  }

  $: claudeCodeAgents = agents.length;

  // ── Skills tab enhancements ─────────────────────────────────────
  let skillSearch = '';
  let skillSourceFilter: 'all' | 'user' | 'plugin' = 'all';
  let skillShowEnabledOnly = false;
  let skillGroupByPlugin = true;

  function toggleAllVisibleSkills(turnOn: boolean) {
    if (!extensions) return;
    const visible = filteredSkills.map(s => s.name);
    const cur = new Set(agentVars.skills);
    if (turnOn) visible.forEach(n => cur.add(n));
    else visible.forEach(n => cur.delete(n));
    scheduleSave({ skills: [...cur] });
  }

  $: filteredSkills = (() => {
    if (!extensions) return [] as Skill[];
    const q = skillSearch.trim().toLowerCase();
    return extensions.skills.filter(s => {
      if (skillSourceFilter === 'user' && s.source !== 'user') return false;
      if (skillSourceFilter === 'plugin' && s.source !== 'plugin') return false;
      if (skillShowEnabledOnly && !agentVars.skills.includes(s.name)) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q) ||
        (s.plugin ?? '').toLowerCase().includes(q)
      );
    });
  })();

  // ── MCP discovery catalog ──────────────────────────────────────
  type McpCategory =
    | 'Official' | 'Anthropic' | 'Community'
    | 'Search' | 'Web'
    | 'Dev tools' | 'Data' | 'Vector DB'
    | 'Cloud' | 'Files'
    | 'Communication' | 'Productivity' | 'Monitoring';
  type McpCatalogEntry = {
    name: string;        // key used in mcp_servers map
    title: string;       // display name
    category: McpCategory;
    description: string;
    transport: 'stdio' | 'http';
    command?: string;    // for stdio
    args?: string[];     // for stdio
    url?: string;        // for http
    env?: Record<string, string>;
    requires?: string[]; // free-form notes: "GITHUB_TOKEN env var", etc.
    homepage?: string;
  };

  const MCP_CATALOG: McpCatalogEntry[] = [
    // ── Official Anthropic reference servers ──
    { name: 'filesystem', title: 'Filesystem', category: 'Official', description: 'Read/write files within an allowlisted directory.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem' },
    { name: 'git', title: 'Git', category: 'Official', description: 'Read repo status, log, diff, and apply commits.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-git'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git' },
    { name: 'github', title: 'GitHub', category: 'Official', description: 'GitHub API — issues, PRs, repos, search. Requires GITHUB_PERSONAL_ACCESS_TOKEN.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' }, requires: ['GITHUB_PERSONAL_ACCESS_TOKEN env'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github' },
    { name: 'gitlab', title: 'GitLab', category: 'Official', description: 'GitLab API — issues, MRs, projects. Requires GITLAB_PERSONAL_ACCESS_TOKEN.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'], env: { GITLAB_PERSONAL_ACCESS_TOKEN: '', GITLAB_API_URL: 'https://gitlab.com/api/v4' }, requires: ['GITLAB_PERSONAL_ACCESS_TOKEN env'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab' },
    { name: 'postgres', title: 'PostgreSQL', category: 'Official', description: 'Read-only SQL queries against a Postgres database.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://user:pass@localhost/db'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres' },
    { name: 'sqlite', title: 'SQLite', category: 'Official', description: 'Query local SQLite databases.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '/tmp/db.sqlite'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite' },
    { name: 'brave-search', title: 'Brave Search', category: 'Search', description: 'Web search via Brave Search API. Requires BRAVE_API_KEY.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '' }, requires: ['BRAVE_API_KEY env'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search' },
    { name: 'google-maps', title: 'Google Maps', category: 'Official', description: 'Geocoding, directions, places via Google Maps. Requires GOOGLE_MAPS_API_KEY.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-maps'], env: { GOOGLE_MAPS_API_KEY: '' }, requires: ['GOOGLE_MAPS_API_KEY env'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps' },
    { name: 'slack', title: 'Slack', category: 'Official', description: 'Read channels, post messages. Requires SLACK_BOT_TOKEN.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' }, requires: ['SLACK_BOT_TOKEN + SLACK_TEAM_ID env'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack' },
    { name: 'memory', title: 'Memory (KV)', category: 'Official', description: 'Persistent key-value memory across conversations.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory' },
    { name: 'sequential-thinking', title: 'Sequential Thinking', category: 'Anthropic', description: 'Structured step-by-step reasoning scratchpad.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking' },
    { name: 'everything', title: 'Everything (demo)', category: 'Official', description: 'Reference server demonstrating all MCP features. Useful for testing.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything' },
    { name: 'puppeteer', title: 'Puppeteer', category: 'Dev tools', description: 'Browser automation — navigate, click, screenshot.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer' },
    { name: 'playwright', title: 'Playwright', category: 'Dev tools', description: 'Cross-browser automation with richer debugging than Puppeteer.', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], homepage: 'https://github.com/microsoft/playwright-mcp' },
    { name: 'fetch', title: 'Fetch', category: 'Official', description: 'Fetch URLs and parse HTML/JSON for the model.', transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch' },
    { name: 'time', title: 'Time', category: 'Official', description: 'Time zone conversions and date helpers.', transport: 'stdio', command: 'uvx', args: ['mcp-server-time'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time' },
    // ── Community / third-party ──
    { name: 'aws', title: 'AWS', category: 'Cloud', description: 'AWS SDK wrapper — S3, EC2, Lambda, CloudWatch. Requires AWS creds.', transport: 'stdio', command: 'uvx', args: ['awslabs.cli-mcp-server@latest'], requires: ['AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY'], homepage: 'https://github.com/awslabs/mcp' },
    { name: 'cloudflare', title: 'Cloudflare', category: 'Cloud', description: 'Workers, R2, KV, D1 admin via the Cloudflare API.', transport: 'http', url: 'https://observability.mcp.cloudflare.com/mcp', homepage: 'https://developers.cloudflare.com/agents/model-context-protocol/' },
    { name: 'notion', title: 'Notion', category: 'Community', description: 'Read/write Notion pages and databases. Requires NOTION_API_KEY.', transport: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_API_KEY: '' }, requires: ['NOTION_API_KEY env'], homepage: 'https://github.com/makenotion/notion-mcp-server' },
    { name: 'linear', title: 'Linear', category: 'Community', description: 'Linear issue tracker — read/write issues, projects.', transport: 'http', url: 'https://mcp.linear.app/sse', homepage: 'https://linear.app/docs/mcp' },
    { name: 'obsidian', title: 'Obsidian', category: 'Community', description: 'Read/write your Obsidian vault.', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-obsidian'], requires: ['OBSIDIAN_VAULT_PATH env'], homepage: 'https://github.com/smithery-ai/mcp-obsidian' },
    { name: 'youtube', title: 'YouTube transcript', category: 'Community', description: 'Fetch YouTube transcripts and video metadata.', transport: 'stdio', command: 'npx', args: ['-y', 'youtube-transcript-mcp'], homepage: 'https://github.com/sahil-s-rajput/mcp-youtube' },

    // ── Official Anthropic reference servers (from modelcontextprotocol/servers) ──
    { name: 'gdrive', title: 'Google Drive', category: 'Files', description: 'Read/search files in Google Drive. Requires OAuth setup.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gdrive'], requires: ['GDRIVE_CREDS_FILE path'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive' },
    { name: 'redis', title: 'Redis', category: 'Data', description: 'Redis operations — get, set, pub/sub, hashes.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-redis', 'redis://localhost:6379'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/redis' },
    { name: 'sentry', title: 'Sentry', category: 'Monitoring', description: 'Read Sentry issues and events. Requires SENTRY_AUTH_TOKEN.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sentry'], env: { SENTRY_AUTH_TOKEN: '' }, requires: ['SENTRY_AUTH_TOKEN env'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sentry' },
    { name: 'aws-kb', title: 'AWS Knowledge Base', category: 'Cloud', description: 'Query AWS Bedrock Knowledge Base for retrieval-augmented answers.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-aws-kb-retrieval'], requires: ['AWS creds + KB_ID'], homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/aws-kb-retrieval-server' },

    // ── Search / Web ──
    { name: 'exa', title: 'Exa', category: 'Search', description: 'AI-powered web search with semantic + keyword modes. Requires EXA_API_KEY.', transport: 'stdio', command: 'npx', args: ['-y', 'exa-mcp-server'], env: { EXA_API_KEY: '' }, requires: ['EXA_API_KEY env'], homepage: 'https://github.com/exa-labs/exa-mcp-server' },
    { name: 'perplexity', title: 'Perplexity Ask', category: 'Search', description: 'Ask Perplexity — grounded web answers with citations. Requires PERPLEXITY_API_KEY.', transport: 'stdio', command: 'npx', args: ['-y', 'server-perplexity-ask'], env: { PERPLEXITY_API_KEY: '' }, requires: ['PERPLEXITY_API_KEY env'], homepage: 'https://github.com/ppl-ai/modelcontextprotocol' },
    { name: 'kagi', title: 'Kagi Search', category: 'Search', description: 'Paid ad-free web search and Universal Summarizer. Requires KAGI_API_KEY.', transport: 'stdio', command: 'uvx', args: ['kagimcp'], env: { KAGI_API_KEY: '' }, requires: ['KAGI_API_KEY env'], homepage: 'https://github.com/kagisearch/kagimcp' },
    { name: 'duckduckgo', title: 'DuckDuckGo', category: 'Search', description: 'Free keyword-based web search, no API key.', transport: 'stdio', command: 'uvx', args: ['duckduckgo-mcp-server'], homepage: 'https://github.com/nickclyde/duckduckgo-mcp-server' },
    { name: 'firecrawl', title: 'Firecrawl', category: 'Web', description: 'Crawl and scrape websites to markdown. Requires FIRECRAWL_API_KEY.', transport: 'stdio', command: 'npx', args: ['-y', 'firecrawl-mcp'], env: { FIRECRAWL_API_KEY: '' }, requires: ['FIRECRAWL_API_KEY env'], homepage: 'https://github.com/mendableai/firecrawl-mcp-server' },
    { name: 'apify', title: 'Apify', category: 'Web', description: 'Run any Apify actor (scraping, automation). Requires APIFY_TOKEN.', transport: 'stdio', command: 'npx', args: ['-y', '@apify/actors-mcp-server'], env: { APIFY_TOKEN: '' }, requires: ['APIFY_TOKEN env'], homepage: 'https://github.com/apify/actors-mcp-server' },
    { name: 'tavily', title: 'Tavily', category: 'Search', description: 'AI-optimized web search and extract. Requires TAVILY_API_KEY.', transport: 'stdio', command: 'npx', args: ['-y', 'tavily-mcp'], env: { TAVILY_API_KEY: '' }, requires: ['TAVILY_API_KEY env'], homepage: 'https://github.com/tavily-ai/tavily-mcp' },

    // ── Dev tools ──
    { name: 'e2e-runner', title: 'E2E Runner (Matware)', category: 'Dev tools', description: 'AI-driven end-to-end browser testing. 13 tools incl. parallel runs against a shared Chrome pool, issue→test automation, visual verification. Also available as plugin + skill.', transport: 'stdio', command: 'npx', args: ['-y', '-p', '@matware/e2e-runner', 'e2e-runner-mcp'], homepage: 'https://github.com/fastslack/mtw-e2e-runner' },
    { name: 'docker', title: 'Docker', category: 'Dev tools', description: 'Manage containers, images, volumes, networks.', transport: 'stdio', command: 'uvx', args: ['docker-mcp'], requires: ['Docker socket reachable'], homepage: 'https://github.com/QuantGeekDev/docker-mcp' },
    { name: 'kubernetes', title: 'Kubernetes', category: 'Dev tools', description: 'Inspect and operate on K8s clusters via kubectl.', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-server-kubernetes'], requires: ['KUBECONFIG reachable'], homepage: 'https://github.com/Flux159/mcp-server-kubernetes' },
    { name: 'shell', title: 'Shell (mac/linux)', category: 'Dev tools', description: 'Run arbitrary shell commands (sandboxing ADVISED).', transport: 'stdio', command: 'uvx', args: ['mcp-shell-server'], requires: ['ALLOW_COMMANDS allowlist'], homepage: 'https://github.com/tumf/mcp-shell-server' },
    { name: 'e2b', title: 'E2B Sandboxes', category: 'Dev tools', description: 'Run code in ephemeral cloud sandboxes. Requires E2B_API_KEY.', transport: 'stdio', command: 'npx', args: ['-y', '@e2b/mcp-server'], env: { E2B_API_KEY: '' }, requires: ['E2B_API_KEY env'], homepage: 'https://github.com/e2b-dev/mcp-server' },

    // ── Cloud ──
    { name: 'stripe', title: 'Stripe', category: 'Cloud', description: 'Stripe API — customers, charges, subscriptions. Requires STRIPE_SECRET_KEY.', transport: 'stdio', command: 'npx', args: ['-y', '@stripe/mcp', '--tools=all'], env: { STRIPE_SECRET_KEY: '' }, requires: ['STRIPE_SECRET_KEY env'], homepage: 'https://github.com/stripe/agent-toolkit' },
    { name: 'vercel', title: 'Vercel', category: 'Cloud', description: 'Manage Vercel projects, deployments, domains. Requires VERCEL_API_TOKEN.', transport: 'stdio', command: 'npx', args: ['-y', '@vercel/mcp-adapter'], env: { VERCEL_API_TOKEN: '' }, requires: ['VERCEL_API_TOKEN env'], homepage: 'https://github.com/vercel/mcp-adapter' },
    { name: 'heroku', title: 'Heroku', category: 'Cloud', description: 'Heroku Platform API — apps, dynos, releases. Requires HEROKU_API_KEY.', transport: 'stdio', command: 'npx', args: ['-y', '@heroku/mcp-server'], env: { HEROKU_API_KEY: '' }, requires: ['HEROKU_API_KEY env'], homepage: 'https://github.com/heroku/heroku-mcp-server' },
    { name: 'azure', title: 'Azure', category: 'Cloud', description: 'Azure resource operations via Azure CLI.', transport: 'stdio', command: 'npx', args: ['-y', '@azure/mcp@latest', 'server', 'start'], requires: ['az login done'], homepage: 'https://github.com/Azure/azure-mcp' },

    // ── Data / DBs ──
    { name: 'mongodb', title: 'MongoDB', category: 'Data', description: 'CRUD and aggregation on MongoDB collections.', transport: 'stdio', command: 'npx', args: ['-y', 'mongodb-mcp-server', '--connectionString', 'mongodb://localhost:27017'], homepage: 'https://github.com/mongodb-js/mongodb-mcp-server' },
    { name: 'clickhouse', title: 'ClickHouse', category: 'Data', description: 'Read-only analytics queries against ClickHouse.', transport: 'stdio', command: 'uvx', args: ['mcp-clickhouse'], env: { CLICKHOUSE_HOST: '', CLICKHOUSE_USER: 'default', CLICKHOUSE_PASSWORD: '' }, requires: ['CLICKHOUSE_HOST env'], homepage: 'https://github.com/ClickHouse/mcp-clickhouse' },
    { name: 'airtable', title: 'Airtable', category: 'Data', description: 'Read and edit Airtable bases. Requires AIRTABLE_API_KEY.', transport: 'stdio', command: 'npx', args: ['-y', 'airtable-mcp-server'], env: { AIRTABLE_API_KEY: '' }, requires: ['AIRTABLE_API_KEY env'], homepage: 'https://github.com/domdomegg/airtable-mcp-server' },
    { name: 'supabase', title: 'Supabase', category: 'Data', description: 'Run SQL, call RPC, manage storage on Supabase projects.', transport: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest'], env: { SUPABASE_ACCESS_TOKEN: '' }, requires: ['SUPABASE_ACCESS_TOKEN env'], homepage: 'https://github.com/supabase-community/supabase-mcp' },
    { name: 'neon', title: 'Neon (Postgres)', category: 'Data', description: 'Serverless Postgres branches and SQL via Neon.', transport: 'stdio', command: 'npx', args: ['-y', '@neondatabase/mcp-server-neon', 'start'], env: { NEON_API_KEY: '' }, requires: ['NEON_API_KEY env'], homepage: 'https://github.com/neondatabase/mcp-server-neon' },

    // ── Vector DBs ──
    { name: 'pinecone', title: 'Pinecone', category: 'Vector DB', description: 'Query and manage Pinecone indices.', transport: 'stdio', command: 'npx', args: ['-y', '@pinecone-database/mcp'], env: { PINECONE_API_KEY: '' }, requires: ['PINECONE_API_KEY env'], homepage: 'https://github.com/pinecone-io/pinecone-mcp' },
    { name: 'qdrant', title: 'Qdrant', category: 'Vector DB', description: 'Vector search + collection management on Qdrant.', transport: 'stdio', command: 'uvx', args: ['mcp-server-qdrant'], env: { QDRANT_URL: 'http://localhost:6333' }, homepage: 'https://github.com/qdrant/mcp-server-qdrant' },
    { name: 'weaviate', title: 'Weaviate', category: 'Vector DB', description: 'Semantic search on Weaviate collections.', transport: 'stdio', command: 'uvx', args: ['mcp-server-weaviate'], env: { WEAVIATE_URL: '', WEAVIATE_API_KEY: '' }, requires: ['WEAVIATE_URL env'], homepage: 'https://github.com/weaviate/mcp-server-weaviate' },
    { name: 'chroma', title: 'Chroma', category: 'Vector DB', description: 'Local vector store — embeddings, similarity search.', transport: 'stdio', command: 'uvx', args: ['chroma-mcp'], homepage: 'https://github.com/chroma-core/chroma-mcp' },

    // ── Communication ──
    { name: 'discord', title: 'Discord', category: 'Communication', description: 'Send/read Discord messages, manage channels. Requires DISCORD_TOKEN.', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-discord'], env: { DISCORD_TOKEN: '' }, requires: ['DISCORD_TOKEN (bot) env'], homepage: 'https://github.com/v-3/discordmcp' },
    { name: 'telegram', title: 'Telegram', category: 'Communication', description: 'Read/send Telegram via Bot API or MTProto.', transport: 'stdio', command: 'uvx', args: ['mcp-telegram'], env: { TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '' }, requires: ['TELEGRAM_* env'], homepage: 'https://github.com/sparfenyuk/mcp-telegram' },
    { name: 'gmail-community', title: 'Gmail (community)', category: 'Communication', description: 'Read/send email via Gmail. Alternative to the native kernel google-sync integration.', transport: 'stdio', command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'], requires: ['OAuth credentials'], homepage: 'https://github.com/GongRzhe/Gmail-MCP-Server' },

    // ── Productivity ──
    { name: 'todoist', title: 'Todoist', category: 'Productivity', description: 'Create/update tasks and projects. Requires TODOIST_API_TOKEN.', transport: 'stdio', command: 'npx', args: ['-y', '@abhiz123/todoist-mcp-server'], env: { TODOIST_API_TOKEN: '' }, requires: ['TODOIST_API_TOKEN env'], homepage: 'https://github.com/abhiz123/todoist-mcp-server' },
    { name: 'jira', title: 'Atlassian Jira', category: 'Productivity', description: 'Jira + Confluence issues/pages. Requires Atlassian API token.', transport: 'stdio', command: 'uvx', args: ['mcp-atlassian'], env: { JIRA_URL: '', JIRA_USERNAME: '', JIRA_API_TOKEN: '' }, requires: ['JIRA_* env'], homepage: 'https://github.com/sooperset/mcp-atlassian' },
    { name: 'figma', title: 'Figma', category: 'Productivity', description: 'Read Figma files + comments via their REST API.', transport: 'stdio', command: 'npx', args: ['-y', 'figma-mcp'], env: { FIGMA_API_KEY: '' }, requires: ['FIGMA_API_KEY env'], homepage: 'https://github.com/GLips/Figma-Context-MCP' },
    { name: 'reddit', title: 'Reddit', category: 'Productivity', description: 'Search + read posts / comments. Requires REDDIT_CLIENT_ID/SECRET.', transport: 'stdio', command: 'uvx', args: ['mcp-server-reddit'], env: { REDDIT_CLIENT_ID: '', REDDIT_CLIENT_SECRET: '' }, requires: ['REDDIT_* env'], homepage: 'https://github.com/adhikasp/mcp-reddit' },
    { name: 'apple-notes', title: 'Apple Notes', category: 'Productivity', description: 'Read/write Apple Notes on macOS via AppleScript.', transport: 'stdio', command: 'uvx', args: ['mcp-server-apple-notes'], requires: ['macOS only'], homepage: 'https://github.com/sirmews/apple-notes-mcp' },

    // ── Monitoring ──
    { name: 'grafana', title: 'Grafana', category: 'Monitoring', description: 'Query dashboards, panels, and Prometheus metrics.', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-grafana'], env: { GRAFANA_URL: '', GRAFANA_API_KEY: '' }, requires: ['GRAFANA_* env'], homepage: 'https://github.com/grafana/mcp-grafana' },

    // ── Files ──
    { name: 'dropbox', title: 'Dropbox', category: 'Files', description: 'List/upload/download files in a Dropbox account.', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-dropbox'], env: { DROPBOX_ACCESS_TOKEN: '' }, requires: ['DROPBOX_ACCESS_TOKEN env'], homepage: 'https://github.com/anthropics/dropbox-mcp' },
  ];

  // Discovery UI state
  let mcpShowDiscover = false;
  let mcpDiscoverCategory: 'All' | McpCatalogEntry['category'] = 'All';
  let mcpDiscoverSearch = '';
  let mcpInstallScope: 'user' | 'agent' = 'user'; // default to Claude Code canonical storage
  // Custom MCP form
  let customMcp = {
    name: '',
    transport: 'stdio' as 'stdio' | 'http',
    command: 'npx',
    args: '',
    url: '',
    env: '',
  };
  let customMcpError = '';

  function installCatalogMcp(entry: McpCatalogEntry) {
    if (mcpInstallScope === 'user') {
      addUserScopeMcp({
        name: entry.name,
        type: entry.transport === 'http' ? 'http' : 'stdio',
        command: entry.command,
        args: entry.args,
        url: entry.url,
        env: entry.env,
      });
      if (entry.requires?.length) {
        setTimeout(() => pushToast('err', 'Fill in the env vars', entry.requires!.join(', ')), 400);
      }
      return;
    }
    // agent-scope override
    const cur = agentVars.mcpServers;
    const next = { ...cur };
    if (entry.transport === 'http') {
      next[entry.name] = { type: 'http', url: entry.url ?? '' };
    } else {
      next[entry.name] = {
        type: 'stdio',
        command: entry.command ?? '',
        args: entry.args ?? [],
        ...(entry.env ? { env: entry.env } : {}),
      };
    }
    scheduleSave({ mcpServers: next });
    pushToast('ok', 'MCP agregado (agent-only)', entry.title);
  }

  function removeCatalogMcp(name: string) {
    // Try user-scope first if it lives there, else the agent-scope override
    if (claudeConfig?.mcpServers[name]) {
      removeUserScopeMcp(name);
      return;
    }
    const cur = agentVars.mcpServers;
    if (!cur[name]) return;
    const next = { ...cur };
    delete next[name];
    scheduleSave({ mcpServers: next });
  }

  // When an MCP is installed we surface its scope so the user knows which
  // table to touch when removing it. In isolate mode, user-scope does NOT count
  // as "installed for this agent" — the agent never sees it at runtime.
  function mcpInstalledScope(name: string): 'user' | 'agent' | null {
    if (agentVars.mcpServers[name]) return 'agent';
    if (agentVars.settingsMode === 'inherit' && claudeConfig?.mcpServers[name]) return 'user';
    return null;
  }

  function addCustomMcp() {
    customMcpError = '';
    const name = customMcp.name.trim();
    if (!name) { customMcpError = 'Missing name (unique slug)'; return; }
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) { customMcpError = 'Name: alfanumérico, guiones y underscores'; return; }
    const existingScope = mcpInstalledScope(name);
    if (existingScope) { customMcpError = `An MCP named "${name}" already exists in ${existingScope} scope — remove it first`; return; }

    let envObj: Record<string, string> | undefined;
    if (customMcp.env.trim()) {
      try {
        envObj = JSON.parse(customMcp.env);
        if (typeof envObj !== 'object' || !envObj) throw new Error('env must be a JSON object');
      } catch (e) {
        customMcpError = 'env inválido: ' + (e instanceof Error ? e.message : String(e));
        return;
      }
    }

    // User scope → write to ~/.claude.json via backend
    if (mcpInstallScope === 'user') {
      void addUserScopeMcp({
        name,
        type: customMcp.transport,
        command: customMcp.transport === 'stdio' ? customMcp.command.trim() : undefined,
        args: customMcp.transport === 'stdio' ? customMcp.args.split(/\s+/).filter(Boolean) : undefined,
        url: customMcp.transport === 'http' ? customMcp.url.trim() : undefined,
        env: envObj,
      });
      customMcp = { name: '', transport: 'stdio', command: 'npx', args: '', url: '', env: '' };
      return;
    }

    // Agent scope → write to agent variables
    const cur = agentVars.mcpServers;
    const entry: Record<string, unknown> = customMcp.transport === 'http'
      ? { type: 'http', url: customMcp.url.trim() }
      : {
          type: 'stdio',
          command: customMcp.command.trim(),
          args: customMcp.args.split(/\s+/).filter(Boolean),
        };
    if (envObj && Object.keys(envObj).length) entry.env = envObj;

    const next = { ...cur, [name]: entry };
    scheduleSave({ mcpServers: next });
    customMcp = { name: '', transport: 'stdio', command: 'npx', args: '', url: '', env: '' };
    pushToast('ok', 'MCP custom agregado (agent-only)', name);
  }

  $: filteredCatalog = (() => {
    const q = mcpDiscoverSearch.trim().toLowerCase();
    return MCP_CATALOG.filter(e => {
      if (mcpDiscoverCategory !== 'All' && e.category !== mcpDiscoverCategory) return false;
      if (!q) return true;
      return (
        e.title.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q)
      );
    });
  })();

  $: catalogCategories = ['All', ...new Set(MCP_CATALOG.map(e => e.category))] as const;

  // ── Per-agent private workspace (plugins + skills) ─────────────
  // Physical copies in data/agents/<id>/{plugins,skills}/ — so an agent can
  // use a plugin/skill that is NOT in ~/.claude/ (full per-agent isolation).
  let privatePlugins: Array<{ name: string; path: string }> = [];
  let privateSkills: Array<{ name: string; path: string }> = [];

  async function loadPrivateWorkspace() {
    if (!selectedAgent) { privatePlugins = []; privateSkills = []; return; }
    try {
      const [pp, ps] = await Promise.all([
        fetch(`/api/agents/${selectedAgent.id}/private-plugins`).then(r => r.ok ? r.json() : { items: [] }),
        fetch(`/api/agents/${selectedAgent.id}/private-skills`).then(r => r.ok ? r.json() : { items: [] }),
      ]);
      privatePlugins = pp.items ?? [];
      privateSkills = ps.items ?? [];
    } catch {
      privatePlugins = [];
      privateSkills = [];
    }
  }
  $: selectedAgentId && loadPrivateWorkspace();

  async function copyPluginToAgent(source: string) {
    if (!selectedAgent) return;
    try {
      const res = await fetch(`/api/agents/${selectedAgent.id}/private-plugins/copy-from-marketplace`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      pushToast('ok', 'Copia privada creada', `${source} → ${selectedAgent.name}`);
      await loadPrivateWorkspace();
    } catch (e) {
      pushToast('err', 'Could not copy', e instanceof Error ? e.message : String(e));
    }
  }

  async function removePrivatePlugin(name: string) {
    if (!selectedAgent) return;
    if (!confirm(`Delete the private copy of "${name}" for ${selectedAgent.name}?\nFiles are removed from data/agents/…/plugins/${name}/. The user-scope plugin is left intact.`)) return;
    try {
      const res = await fetch(`/api/agents/${selectedAgent.id}/private-plugins/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      pushToast('ok', 'Copia privada borrada', name);
      await loadPrivateWorkspace();
    } catch (e) {
      pushToast('err', 'Could not delete', e instanceof Error ? e.message : String(e));
    }
  }

  async function copySkillToAgent(name: string) {
    if (!selectedAgent) return;
    try {
      const res = await fetch(`/api/agents/${selectedAgent.id}/private-skills/copy-from-user`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      pushToast('ok', 'Copia privada creada', `${name} → ${selectedAgent.name}`);
      await loadPrivateWorkspace();
    } catch (e) {
      pushToast('err', 'Could not copy', e instanceof Error ? e.message : String(e));
    }
  }

  async function removePrivateSkill(name: string) {
    if (!selectedAgent) return;
    if (!confirm(`Delete the private copy of skill "${name}" for ${selectedAgent.name}?`)) return;
    try {
      const res = await fetch(`/api/agents/${selectedAgent.id}/private-skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      pushToast('ok', 'Copia privada borrada', name);
      await loadPrivateWorkspace();
    } catch (e) {
      pushToast('err', 'Could not delete', e instanceof Error ? e.message : String(e));
    }
  }

  // Effective MCPs for the selected agent — merges shared + agent-only, honoring isolation mode.
  // Agent overrides WIN when a name exists in both. In isolate mode, shared entries are hidden.
  type EffectiveMcp = { name: string; srv: any; origin: 'shared' | 'agent' };
  $: effectiveMcps = (() => {
    const agentOnly = agentVars.mcpServers ?? {};
    const shared = claudeConfig?.mcpServers ?? {};
    const list: EffectiveMcp[] = [];
    if (agentVars.settingsMode !== 'isolate') {
      for (const [name, srv] of Object.entries(shared)) {
        if (name in agentOnly) continue;
        list.push({ name, srv, origin: 'shared' });
      }
    }
    for (const [name, srv] of Object.entries(agentOnly)) {
      list.push({ name, srv, origin: 'agent' });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  })();

  $: groupedSkills = (() => {
    if (!skillGroupByPlugin) return [{ label: '', items: filteredSkills }];
    const groups = new Map<string, Skill[]>();
    const userKey = 'User skills';
    for (const s of filteredSkills) {
      const k = s.source === 'user' ? userKey : `Plugin · ${s.plugin ?? s.marketplace ?? 'unknown'}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(s);
    }
    // User group first, then alphabetical
    return [...groups.entries()]
      .sort(([a], [b]) => (a === userKey ? -1 : b === userKey ? 1 : a.localeCompare(b)))
      .map(([label, items]) => ({ label, items }));
  })();
</script>

<div class="hi-wrap">
  <div class="hi-head">
    <div>
      <h2>Host Integrations</h2>
      <p class="sub">Host skills, plugins and MCPs — pick what each <code>claude_code</code> agent uses.</p>
    </div>
    <button class="refresh" on:click={load} disabled={loading}>↻ Reload</button>
  </div>

  {#if error}<div class="err-banner">{error}<button on:click={() => error=''}>✕</button></div>{/if}

  {#if loading}
    <div class="muted">Loading host inventory…</div>
  {:else if claudeCodeAgents === 0}
    <div class="muted">No agents use the <code>claude_code</code> executor.<br>Enable one in <a href="/models">/models</a> first.</div>
  {:else if extensions}
    <div class="kpis">
      <div class="kpi"><b>{extensions.counts.skills}</b><span>Skills disponibles</span></div>
      <div class="kpi"><b>{extensions.counts.plugins}</b><span>Plugins instalados</span></div>
      <div class="kpi"><b>{extensions.counts.mcps}</b><span>MCPs conocidos</span></div>
      <div class="kpi"><b>{claudeCodeAgents}</b><span>claude_code agents</span></div>
    </div>

    <!-- Unified header: agent picker + config mode. No jargon, two clear choices. -->
    <div class="hdr">
      <div class="hdr-slot">
        <span class="hdr-label">Agent</span>
        <select class="hdr-select" bind:value={selectedAgentId}>
          {#each agents as a}<option value={a.id}>{a.name}</option>{/each}
        </select>
      </div>
      <div class="hdr-sep"></div>
      <div class="hdr-slot">
        <span class="hdr-label">Config</span>
        <div class="hdr-mode-tabs">
          <button
            class="hdr-mode"
            class:active={agentVars.settingsMode === 'inherit'}
            on:click={() => setSettingsMode('inherit')}
            title="Inherits MCPs/plugins from ~/.claude.json plus whatever you add here"
          >
            🌍 Shared
          </button>
          <button
            class="hdr-mode"
            class:active={agentVars.settingsMode === 'isolate'}
            on:click={() => setSettingsMode('isolate')}
            title="Only sees what you configure here explicitly"
          >
            🔒 Private
          </button>
        </div>
      </div>
      <div class="hdr-actions">
        <button
          class="hdr-copy"
          on:click={copyUserScopeToAgent}
          disabled={!claudeConfig || Object.keys(claudeConfig?.mcpServers ?? {}).length === 0}
          title="Clone the shared MCPs + plugins onto this agent as a baseline"
        >
          📋 Copy shared as baseline
        </button>
        {#if inflight}<span class="spinner"></span>{/if}
      </div>
    </div>

    <p class="hdr-caption">
      {#if agentVars.settingsMode === 'inherit'}
        <b>Shared mode:</b> the agent sees everything in <code>~/.claude.json</code> (the same as the <code>claude</code> CLI) plus any MCP or plugin you add below just for it.
      {:else}
        <b>Private mode:</b> the agent <b>ignores</b> <code>~/.claude.json</code>. It only sees the MCPs / plugins you configure explicitly here. Use <b>“Copy shared as baseline”</b> to start from the current set as a template.
      {/if}
    </p>

    <div class="tabs">
      <button class:active={tab === 'skills'} on:click={() => tab='skills'}>
        Skills <span class="pill">{agentVars.skills.length}/{extensions.counts.skills}</span>
      </button>
      <button class:active={tab === 'plugins'} on:click={() => tab='plugins'}>
        Plugins <span class="pill">{agentVars.plugins.length}/{extensions.counts.plugins}</span>
      </button>
      <button class:active={tab === 'mcps'} on:click={() => tab='mcps'}>
        MCPs <span class="pill">{Object.keys(agentVars.mcpServers).length}/{extensions.counts.mcps}</span>
      </button>
      <button class:active={tab === 'marketplaces'} on:click={() => tab='marketplaces'}>
        Marketplaces <span class="pill">{marketplaces.length}</span>
      </button>
    </div>

    {#if tab === 'skills'}
      <div class="plug-note">
        Skills in <code>~/.claude/skills/</code> are <b>auto-discovered by the SDK</b> — inherit mode sees all of them.
        <br>Checkboxes here are a <b>bind-mount filter</b> (only applies with <code>__container_sandbox__: true</code>).
        <br><b>🔒 Private copy</b> = physical files under <code>data/agents/&lt;id&gt;/skills/&lt;name&gt;/</code> — they work even in <b>isolate mode</b>.
      </div>

      <!-- Agent-private skills section -->
      {#if selectedAgent}
        <div class="priv-section">
          <div class="priv-head">
            <span class="priv-title">🔒 Private copies for {selectedAgent.name}</span>
            <span class="priv-count">{privateSkills.length}</span>
          </div>
          {#if privateSkills.length === 0}
            <div class="priv-empty">
              No private copies yet. The <b>"📋 Copy private"</b> button on each user-scope skill below makes a physical copy.
            </div>
          {:else}
            <div class="priv-list">
              {#each privateSkills as ps (ps.name)}
                <div class="priv-item">
                  <span class="mono">{ps.name}</span>
                  <code class="priv-path">{ps.path}</code>
                  <button class="priv-remove" on:click={() => removePrivateSkill(ps.name)} title="Delete private copy">×</button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <!-- Toolbar: search + source filter + show enabled only + bulk toggle -->
      <div class="sk-toolbar">
        <div class="sk-search-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sk-search-icon" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input
            class="sk-search"
            type="text"
            placeholder="Search by name, description or plugin…"
            bind:value={skillSearch}
          />
          {#if skillSearch}
            <button class="sk-search-clear" on:click={() => (skillSearch = '')} title="Limpiar">×</button>
          {/if}
        </div>

        <div class="sk-chips">
          <button
            class="sk-chip"
            class:active={skillSourceFilter === 'all'}
            on:click={() => (skillSourceFilter = 'all')}
          >All <span class="sk-chip-n">{extensions.skills.length}</span></button>
          <button
            class="sk-chip"
            class:active={skillSourceFilter === 'user'}
            on:click={() => (skillSourceFilter = 'user')}
          >User <span class="sk-chip-n">{extensions.skills.filter(s => s.source === 'user').length}</span></button>
          <button
            class="sk-chip"
            class:active={skillSourceFilter === 'plugin'}
            on:click={() => (skillSourceFilter = 'plugin')}
          >Plugin <span class="sk-chip-n">{extensions.skills.filter(s => s.source === 'plugin').length}</span></button>
        </div>

        <label class="sk-toggle">
          <input type="checkbox" bind:checked={skillShowEnabledOnly} />
          Solo habilitadas
        </label>

        <label class="sk-toggle">
          <input type="checkbox" bind:checked={skillGroupByPlugin} />
          Agrupar
        </label>
      </div>

      <!-- Bulk + summary row -->
      <div class="sk-bulk">
        <span class="sk-summary">
          Showing <b>{filteredSkills.length}</b> of {extensions.skills.length} · Enabled: <b>{agentVars.skills.length}</b>
        </span>
        <div class="sk-bulk-actions">
          <button class="sk-bulk-btn" on:click={() => toggleAllVisibleSkills(true)} disabled={filteredSkills.length === 0}>
            Activar visibles
          </button>
          <button class="sk-bulk-btn" on:click={() => toggleAllVisibleSkills(false)} disabled={filteredSkills.length === 0}>
            Desactivar visibles
          </button>
        </div>
      </div>

      {#if filteredSkills.length === 0}
        <div class="sk-empty">
          {#if skillSearch || skillSourceFilter !== 'all' || skillShowEnabledOnly}
            <p>No skills match the current filters.</p>
            <button class="sk-bulk-btn" on:click={() => { skillSearch = ''; skillSourceFilter = 'all'; skillShowEnabledOnly = false; }}>
              Limpiar filtros
            </button>
          {:else}
            <p>No skills installed on the host.</p>
            <p class="sk-hint">Install them with <code>claude skills install &lt;name&gt;</code>, or by cloning a plugin marketplace from the Marketplaces tab.</p>
          {/if}
        </div>
      {:else}
        {#each groupedSkills as group (group.label)}
          {#if group.label}
            <div class="sk-group-head">
              <span class="sk-group-label">{group.label}</span>
              <span class="sk-group-count">{group.items.length}</span>
            </div>
          {/if}
          <div class="sk-grid">
            {#each group.items as s (s.path)}
              {@const active = agentVars.skills.includes(s.name)}
              {@const hasPrivSkill = privateSkills.some(ps => ps.name === s.name)}
              <label class="sk-card" class:active class:sk-card-private={hasPrivSkill}>
                <div class="sk-card-toggle">
                  <input type="checkbox" checked={active} on:change={() => toggleSkill(s.name)}>
                </div>
                <div class="sk-card-body">
                  <div class="sk-card-head">
                    <span class="sk-card-name">{s.name}</span>
                    {#if s.source === 'user'}
                      <span class="sk-badge sk-badge-user">USER</span>
                    {:else}
                      <span class="sk-badge sk-badge-plugin">{s.plugin}</span>
                    {/if}
                    {#if hasPrivSkill}
                      <span class="sk-badge sk-badge-priv">🔒 PRIVATE</span>
                    {/if}
                  </div>
                  <p class="sk-card-desc">{s.description || 'No description'}</p>
                  <code class="sk-card-path" title={s.path}>{s.path}</code>
                  {#if s.source === 'user' && selectedAgent}
                    <div class="sk-card-priv-actions">
                      {#if hasPrivSkill}
                        <button type="button" class="sk-priv-btn active" on:click={() => removePrivateSkill(s.name)} title="Delete private copy">
                          🔒 Private ✓
                        </button>
                      {:else}
                        <button type="button" class="sk-priv-btn" on:click={() => copySkillToAgent(s.name)} title="Crea copia física en data/agents/<id>/skills/ (funciona en isolate mode)">
                          📋 Copy private
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
              </label>
            {/each}
          </div>
        {/each}
      {/if}
    {:else if tab === 'plugins'}
      <div class="plug-note">
        Three levels, from most shared to most isolated:
        <br>&nbsp;&nbsp;<b>🌍 Shared enable</b> — <code>~/.claude/settings.json → enabledPlugins</code>. Every inherit-mode agent sees it (so does the CLI).
        <br>&nbsp;&nbsp;<b>🗂️ Agent bind-mount</b> — <code>agent.variables.__plugins__</code>. Filtro de bind-mount en sandbox mode.
        <br>&nbsp;&nbsp;<b>🔒 Private copy</b> — <code>data/agents/&lt;id&gt;/plugins/&lt;name&gt;/</code>. Physical plugin files <i>private</i> to this agent. The executor resolves here first — it works even when the agent is in <b>isolate mode</b>.
      </div>

      <!-- ── Agent-private plugins (physical copies) ── -->
      {#if selectedAgent}
        <div class="priv-section">
          <div class="priv-head">
            <span class="priv-title">🔒 Private copies for {selectedAgent.name}</span>
            <span class="priv-count">{privatePlugins.length}</span>
          </div>
          {#if privatePlugins.length === 0}
            <div class="priv-empty">
              None yet. The <b>"📋 Copy private"</b> button on each user-scope plugin below makes a physical copy for this agent.
            </div>
          {:else}
            <div class="priv-list">
              {#each privatePlugins as pp (pp.name)}
                <div class="priv-item">
                  <span class="mono">{pp.name}</span>
                  <code class="priv-path">{pp.path}</code>
                  <button class="priv-remove" on:click={() => removePrivatePlugin(pp.name)} title="Delete private copy (user-scope plugin remains intact)">×</button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <div class="grid">
        {#each extensions.plugins as p (p.path)}
          {@const ref = `${p.marketplace}/${p.name}`}
          {@const pluginName = `${p.name}@${p.marketplace}`}
          {@const userEnabled = claudeConfig?.enabledPlugins?.[pluginName] === true}
          {@const agentFilter = agentVars.plugins.includes(ref)}
          {@const hasPrivate = privatePlugins.some(pp => pp.name === p.name)}
          <div class="plug-card" class:user-enabled={userEnabled}>
            <div class="plug-card-body">
              <div class="plug-card-head">
                <span class="plug-name">{p.name}</span>
                <span class="plug-mk">{p.marketplace}</span>
                {#if userEnabled}<span class="plug-badge plug-badge-user">🌍 enabled</span>{/if}
                {#if agentFilter}<span class="plug-badge plug-badge-agent">🤖 bind-mount</span>{/if}
              </div>
              <p class="plug-desc">{p.description || '— no description —'}</p>
              <div class="provides">
                {#if p.provides.skills.length}<span class="prov-pill">🎯 {p.provides.skills.length} skills</span>{/if}
                {#if p.provides.agents.length}<span class="prov-pill">🤖 {p.provides.agents.length} agents</span>{/if}
                {#if p.provides.commands.length}<span class="prov-pill">⚡ {p.provides.commands.length} commands</span>{/if}
              </div>
            </div>
            <div class="plug-card-actions">
              <button
                class="plug-toggle-btn"
                class:active={userEnabled}
                on:click={() => setUserScopePluginEnabled(pluginName, !userEnabled)}
                title="Toggle user-scope enable (Claude canonical)"
              >
                {userEnabled ? '✓ Shared' : '+ Shared'}
              </button>
              <button
                class="plug-copy-private"
                class:active={hasPrivate}
                on:click={() => hasPrivate ? removePrivatePlugin(p.name) : copyPluginToAgent(ref)}
                disabled={!selectedAgent}
                title={hasPrivate ? 'A private copy already exists for this agent — click to delete it' : 'Creates a physical copy under data/agents/<id>/plugins/, visible only to this agent (works with isolate mode)'}
              >
                {hasPrivate ? '🔒 Private ✓' : '📋 Copy private'}
              </button>
              <label class="plug-agent-toggle">
                <input type="checkbox" checked={agentFilter} on:change={() => togglePlugin(ref)} />
                <span>bind-mount</span>
              </label>
            </div>
          </div>
        {/each}
      </div>
    {:else if tab === 'mcps'}
      <!-- ONE unified list of what THIS agent actually sees at runtime. -->
      <div class="mcp-head-row">
        <div>
          <h3 class="mcp-head-title">MCPs available to {selectedAgent?.name ?? 'this agent'}</h3>
          <div class="mcp-head-sub">
            {effectiveMcps.length} total
            {#if agentVars.settingsMode === 'inherit'}
              · {effectiveMcps.filter(e => e.origin === 'shared').length} shared · {effectiveMcps.filter(e => e.origin === 'agent').length} private
            {:else}
              · all private
            {/if}
          </div>
        </div>
      </div>

      {#if effectiveMcps.length === 0}
        <div class="mcp-empty-box">
          <p>No MCPs todavía.</p>
          <p class="mcp-empty-sub">Add one from the catalog below, or with the custom form.</p>
        </div>
      {:else}
        <div class="mcp-list-clean">
          {#each effectiveMcps as item (item.name)}
            <div class="mcp-item" class:mcp-item-shared={item.origin === 'shared'} class:mcp-item-agent={item.origin === 'agent'}>
              <div class="mcp-item-origin" title={item.origin === 'shared' ? 'Shared: lives in ~/.claude.json. Every inherit-mode agent sees it.' : 'Private: this agent only.'}>
                {item.origin === 'shared' ? '🌍' : '🔒'}
              </div>
              <div class="mcp-item-main">
                <div class="mcp-item-name">
                  <span class="mono">{item.name}</span>
                  <span class="mcp-item-type">{item.srv?.type ?? 'stdio'}</span>
                </div>
                <code class="mcp-item-cmd">
                  {#if item.srv?.command}{item.srv.command} {(item.srv.args ?? []).join(' ')}{:else if item.srv?.url}{item.srv.url}{/if}
                </code>
              </div>
              <button
                class="mcp-item-remove"
                on:click={() => {
                  if (item.origin === 'shared') removeUserScopeMcp(item.name);
                  else { const next = { ...agentVars.mcpServers }; delete next[item.name]; scheduleSave({ mcpServers: next }); }
                }}
                title={item.origin === 'shared' ? 'Remove from shared (~/.claude.json) — affects every agent' : 'Remove from this agent'}
              >×</button>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Discover public MCPs -->
      <div class="mcp-discover-toggle" on:click={() => (mcpShowDiscover = !mcpShowDiscover)} role="button" tabindex="0" on:keydown={(e) => e.key === 'Enter' && (mcpShowDiscover = !mcpShowDiscover)}>
        <span class="mcp-dt-caret" class:open={mcpShowDiscover}>▶</span>
        <span class="mcp-dt-title">Browse public MCPs</span>
        <span class="mcp-dt-sub">{MCP_CATALOG.length} available · click to expand</span>
      </div>

      {#if mcpShowDiscover}
        <div class="mcp-discover">
          <!-- Scope picker: where does "+ Add" put the MCP -->
          <div class="mcp-scope-picker">
            <span class="mcp-scope-picker-label">Add to:</span>
            <button class:active={mcpInstallScope === 'user'} on:click={() => (mcpInstallScope = 'user')}>
              🌍 Shared <span class="mcp-scope-picker-sub">(all agents + CLI)</span>
            </button>
            <button class:active={mcpInstallScope === 'agent'} on:click={() => (mcpInstallScope = 'agent')}>
              🔒 Only this agent
            </button>
          </div>

          <div class="mcp-discover-toolbar">
            <div class="sk-search-wrap mcp-search-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sk-search-icon" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
              </svg>
              <input class="sk-search" type="text" placeholder="Search public MCPs…" bind:value={mcpDiscoverSearch} />
              {#if mcpDiscoverSearch}
                <button class="sk-search-clear" on:click={() => (mcpDiscoverSearch = '')} title="Limpiar">×</button>
              {/if}
            </div>
            <div class="sk-chips mcp-cat-chips">
              {#each catalogCategories as cat}
                <button
                  class="sk-chip"
                  class:active={mcpDiscoverCategory === cat}
                  on:click={() => (mcpDiscoverCategory = cat)}
                >{cat}</button>
              {/each}
            </div>
          </div>

          <div class="mcp-catalog-grid">
            {#each filteredCatalog as c (c.name)}
              {@const installedScope = mcpInstalledScope(c.name)}
              {@const installed = installedScope !== null}
              <div class="mcp-cat-card" class:installed>
                <div class="mcp-cat-head">
                  <span class="mcp-cat-title">{c.title}</span>
                  <span class="mcp-cat-slug">{c.name}</span>
                  <span class="mcp-cat-cat">{c.category}</span>
                </div>
                <p class="mcp-cat-desc">{c.description}</p>
                <div class="mcp-cat-meta">
                  <span class="mcp-cat-tr mcp-tr-{c.transport}">{c.transport}</span>
                  {#if c.command}<code class="mcp-cat-cmd">{c.command} {(c.args ?? []).join(' ')}</code>{/if}
                  {#if c.url}<code class="mcp-cat-cmd">{c.url}</code>{/if}
                </div>
                {#if c.requires?.length}
                  <div class="mcp-cat-req">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" />
                    </svg>
                    Requiere: {c.requires.join(', ')}
                  </div>
                {/if}
                {#if installed && installedScope}
                  <div class="mcp-cat-installed">
                    {#if installedScope === 'user'}
                      <span class="mcp-cat-installed-badge mcp-cat-installed-user">🌍 En user scope</span>
                    {:else}
                      <span class="mcp-cat-installed-badge mcp-cat-installed-agent">🤖 This agent only</span>
                    {/if}
                  </div>
                {/if}
                <div class="mcp-cat-actions">
                  {#if c.homepage}
                    <a class="mcp-cat-link" href={c.homepage} target="_blank" rel="noopener">docs ↗</a>
                  {/if}
                  {#if installed}
                    <button class="mcp-cat-btn mcp-cat-btn-off" on:click={() => removeCatalogMcp(c.name)}>Remove</button>
                  {:else}
                    <button class="mcp-cat-btn" on:click={() => installCatalogMcp(c)}>+ Add</button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

          {#if filteredCatalog.length === 0}
            <div class="sk-empty">
              <p>Nothing matches your search.</p>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Custom MCP form -->
      <div class="mcp-custom">
        <div class="mcp-custom-head">
          <span class="mcp-section-label">Add custom MCP</span>
          <span class="mcp-section-hint">Not in the catalog? Paste it in by hand.</span>
        </div>
        <div class="mcp-custom-row">
          <label class="mcp-field">
            <span>Name (unique slug)</span>
            <input type="text" bind:value={customMcp.name} placeholder="my-mcp" />
          </label>
          <label class="mcp-field mcp-field-sm">
            <span>Transport</span>
            <select bind:value={customMcp.transport}>
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </label>
        </div>
        {#if customMcp.transport === 'stdio'}
          <div class="mcp-custom-row">
            <label class="mcp-field mcp-field-sm">
              <span>Command</span>
              <input type="text" bind:value={customMcp.command} placeholder="npx" />
            </label>
            <label class="mcp-field">
              <span>Args (space-separated)</span>
              <input type="text" bind:value={customMcp.args} placeholder="-y @some/mcp-server" />
            </label>
          </div>
        {:else}
          <label class="mcp-field">
            <span>URL</span>
            <input type="url" bind:value={customMcp.url} placeholder="https://example.com/mcp" />
          </label>
        {/if}
        <label class="mcp-field">
          <span>Env (JSON opcional, ej: <code>{'{"TOKEN":"..."}'}</code>)</span>
          <input type="text" bind:value={customMcp.env} placeholder={'{"API_KEY": ""}'} />
        </label>
        {#if customMcpError}
          <div class="mcp-custom-err">{customMcpError}</div>
        {/if}
        <div class="mcp-custom-actions">
          <button class="mcp-cat-btn" on:click={addCustomMcp}>+ Add to agent</button>
        </div>
      </div>
    {:else if tab === 'marketplaces'}
      <div class="mp-add">
        <label>
          <span>Clone marketplace from URL</span>
          <div class="mp-add-row">
            <input
              type="url"
              bind:value={addUrl}
              placeholder="https://github.com/anthropics/claude-plugins"
              on:keydown={(e) => e.key === 'Enter' && !addBusy && addMarketplace()}
              disabled={addBusy}
            />
            <button class="btn-primary" on:click={addMarketplace} disabled={addBusy || !addUrl.trim()}>
              {#if addBusy}<span class="spinner"></span>&nbsp;Cloning…{:else}+ Add{/if}
            </button>
          </div>
        </label>
        <p class="mp-hint">
          Acepta URLs https de <code>github.com</code>, <code>gitlab.com</code>, <code>codeberg.org</code>, <code>bitbucket.org</code>.
          The repo must contain <code>plugins/</code> or <code>.claude-plugin/marketplace.json</code>.
        </p>
      </div>

      <div class="mp-list">
        {#each marketplaces as mp (mp.id)}
          <div class="mp-card">
            <div class="mp-card-main">
              <div class="mp-title">
                <span class="mp-name">{mp.title}</span>
                {#if mp.name !== mp.title}<span class="mp-dirname">{mp.name}/</span>{/if}
                <span class="mp-count">{mp.plugin_count} plugins</span>
              </div>
              {#if mp.description}<p class="mp-desc">{mp.description}</p>{/if}
              {#if mp.git_url}<code class="mp-url">{mp.git_url}</code>{/if}
              {#if mp.last_commit}<div class="mp-last">📅 {mp.last_commit}</div>{/if}
            </div>
            <div class="mp-actions">
              {#if mp.git_url}
                <button class="btn-sm" on:click={() => refreshMarketplace(mp.name)} disabled={mpBusy[mp.name]} title="git pull">
                  {#if mpBusy[mp.name]}<span class="spinner"></span>{:else}↻{/if}
                </button>
              {/if}
              <button class="btn-sm btn-danger" on:click={() => removeMarketplace(mp.name)} disabled={mpBusy[mp.name]} title="Remover marketplace">✕</button>
            </div>
          </div>
        {/each}
        {#if marketplaces.length === 0}
          <div class="muted">No marketplaces installed. Clone one above to get started.</div>
        {/if}
      </div>
    {/if}
  {/if}

  <div class="toast-stack">
    {#each toasts as t (t.id)}
      <div class="toast" class:err={t.kind === 'err'}>
        <span class="ic">{t.kind === 'ok' ? '✓' : '✕'}</span>
        <div>
          <div class="t-title">{t.title}</div>
          {#if t.detail}<div class="t-sub">{t.detail}</div>{/if}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .hi-wrap { padding: 0; max-width: 1400px; margin: 0 auto; }
  .hi-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; gap: 20px; }
  .hi-head h2 { margin: 0; font-size: 18px; font-weight: 700; }
  .sub { font-size: 12px; color: var(--muted, #8fa0c3); margin: 4px 0 0; }
  .sub code { background: rgba(90,110,160,0.14); padding: 1px 5px; border-radius: 3px; font-size: 90%; }
  .refresh {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(120,140,200,0.25));
    color: var(--muted, #8fa0c3);
    padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;
  }
  .refresh:hover { color: var(--fg, #e8ecf5); }
  .refresh:disabled { opacity: 0.5; }

  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
  .kpi {
    background: var(--panel-bg, rgba(18,22,38,0.6));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.2));
    border-radius: 6px;
    padding: 10px 14px;
    display: flex; flex-direction: column; gap: 2px;
  }
  .kpi b { font-size: 22px; font-weight: 700; }
  .kpi span { font-size: 10px; color: var(--muted, #8fa0c3); text-transform: uppercase; letter-spacing: 0.05em; }

  .agent-picker {
    display: flex; align-items: center; gap: 10px;
    background: rgba(99,102,241,0.06);
    border: 1px solid rgba(99,102,241,0.25);
    padding: 10px 14px; border-radius: 6px;
    margin-bottom: 14px;
    font-size: 13px;
  }
  .agent-picker label { color: var(--muted, #8fa0c3); font-weight: 600; }
  .agent-picker select {
    background: var(--panel-bg, rgba(18,22,38,0.8));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.3));
    color: inherit;
    padding: 5px 10px; border-radius: 4px;
    font-size: 13px;
    min-width: 260px;
    font-family: 'Fira Code', monospace;
  }

  .spinner {
    width: 12px; height: 12px;
    border: 2px solid rgba(90,110,160,0.2);
    border-top-color: #6366f1;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--panel-border, rgba(90,110,160,0.15)); }
  .tabs button {
    background: transparent; border: none;
    padding: 8px 16px;
    color: var(--muted, #8fa0c3);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.03em;
    border-bottom: 2px solid transparent;
    display: flex; align-items: center; gap: 8px;
  }
  .tabs button:hover { color: var(--fg, #e8ecf5); }
  .tabs button.active { color: var(--fg, #e8ecf5); border-bottom-color: #6366f1; }
  .tabs .pill {
    font-size: 10px;
    background: rgba(90,110,160,0.15);
    padding: 1px 6px; border-radius: 8px;
    font-family: 'Fira Code', monospace;
  }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }

  /* ── Skills tab — enhanced ──────────────────────────────────── */
  .sk-toolbar {
    display: grid;
    grid-template-columns: 1fr auto auto auto;
    gap: 10px;
    align-items: center;
    margin-bottom: 10px;
    padding: 10px 12px;
    background: var(--panel-bg, rgba(18,22,38,0.5));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.18));
    border-radius: 8px;
  }
  .sk-search-wrap {
    position: relative;
    min-width: 260px;
  }
  .sk-search-icon {
    position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    width: 14px; height: 14px; color: var(--muted, #8fa0c3);
    pointer-events: none;
  }
  .sk-search {
    width: 100%;
    background: var(--panel-bg, rgba(18,22,38,0.8));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.25));
    color: inherit;
    padding: 8px 32px 8px 32px; border-radius: 6px;
    font-size: 12.5px;
  }
  .sk-search:focus { outline: none; border-color: #6366f1; }
  .sk-search-clear {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    width: 20px; height: 20px; border: none; background: transparent;
    color: var(--muted, #8fa0c3); font-size: 18px; line-height: 1; cursor: pointer;
    border-radius: 4px;
  }
  .sk-search-clear:hover { background: rgba(255,255,255,0.06); color: var(--fg, #e8ecf5); }

  .sk-chips { display: flex; gap: 4px; }
  .sk-chip {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(120,140,200,0.25));
    color: var(--muted, #8fa0c3);
    padding: 6px 12px; border-radius: 999px;
    cursor: pointer; font-size: 11.5px; font-weight: 600;
    display: inline-flex; align-items: center; gap: 6px;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
  }
  .sk-chip:hover { color: var(--fg, #e8ecf5); border-color: rgba(99,102,241,0.5); }
  .sk-chip.active {
    border-color: rgba(99,102,241,0.8);
    background: rgba(99,102,241,0.12);
    color: var(--fg, #e8ecf5);
  }
  .sk-chip-n {
    font-size: 10px; background: rgba(90,110,160,0.2);
    padding: 1px 6px; border-radius: 10px;
    font-family: 'Fira Code', monospace;
  }
  .sk-chip.active .sk-chip-n { background: rgba(99,102,241,0.35); color: #c5d0ff; }

  .sk-toggle {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11.5px; color: var(--muted, #8fa0c3); cursor: pointer;
    user-select: none;
    padding: 6px 8px; border-radius: 6px;
    white-space: nowrap;
  }
  .sk-toggle:hover { color: var(--fg, #e8ecf5); }
  .sk-toggle input { cursor: pointer; }

  .sk-bulk {
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px;
    margin-bottom: 10px;
    padding: 2px 6px;
  }
  .sk-summary { font-size: 11.5px; color: var(--muted, #8fa0c3); }
  .sk-summary b { color: var(--fg, #e8ecf5); font-family: 'Fira Code', monospace; }
  .sk-bulk-actions { display: flex; gap: 6px; }
  .sk-bulk-btn {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(120,140,200,0.25));
    color: var(--muted, #8fa0c3);
    padding: 6px 12px; border-radius: 6px;
    cursor: pointer; font-size: 11.5px; font-weight: 600;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
  }
  .sk-bulk-btn:hover:not(:disabled) {
    color: var(--fg, #e8ecf5);
    border-color: rgba(99,102,241,0.5);
    background: rgba(99,102,241,0.06);
  }
  .sk-bulk-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  .sk-group-head {
    display: flex; align-items: center; gap: 8px;
    margin: 14px 2px 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--panel-border, rgba(90,110,160,0.15));
  }
  .sk-group-label {
    font-size: 11px; font-weight: 700;
    color: var(--muted, #a8b5d1);
    letter-spacing: 0.05em; text-transform: uppercase;
  }
  .sk-group-count {
    font-size: 10px; background: rgba(90,110,160,0.18);
    padding: 1px 7px; border-radius: 10px;
    color: var(--muted, #8fa0c3);
    font-family: 'Fira Code', monospace;
  }

  .sk-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 8px;
  }

  .sk-card {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 10px;
    padding: 12px 14px;
    background: var(--panel-bg, rgba(18,22,38,0.45));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.18));
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s;
  }
  .sk-card:hover { border-color: rgba(99,102,241,0.35); background: var(--panel-bg, rgba(18,22,38,0.7)); }
  .sk-card.active {
    border-color: rgba(99,102,241,0.7);
    background: rgba(99,102,241,0.08);
  }
  .sk-card-toggle { padding-top: 2px; }
  .sk-card-toggle input {
    width: 16px; height: 16px; cursor: pointer;
    accent-color: #6366f1;
  }
  .sk-card-body { min-width: 0; }
  .sk-card-head {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .sk-card-name {
    font-weight: 700; font-size: 13px; color: var(--fg, #e8ecf5);
    font-family: 'Fira Code', monospace;
    word-break: break-word;
  }
  .sk-badge {
    font-size: 9px; font-weight: 700;
    padding: 2px 7px; border-radius: 10px;
    letter-spacing: 0.04em; text-transform: uppercase;
    font-family: 'Fira Code', monospace;
    line-height: 1.5;
  }
  .sk-badge-user {
    background: rgba(61,214,140,0.12);
    color: #3dd68c;
    border: 1px solid rgba(61,214,140,0.25);
  }
  .sk-badge-plugin {
    background: rgba(99,102,241,0.12);
    color: #a3b3ff;
    border: 1px solid rgba(99,102,241,0.25);
    text-transform: none; letter-spacing: 0;
  }
  .sk-card-desc {
    font-size: 12px; line-height: 1.5;
    color: var(--muted, #a8b5d1);
    margin: 2px 0 6px; /* tighter */
    /* 2 lines max, ellipsis */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .sk-card-path {
    font-size: 10px; color: rgba(150,170,210,0.55);
    font-family: 'Fira Code', monospace;
    display: block;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .sk-empty {
    padding: 48px 24px; text-align: center;
    color: var(--muted, #8fa0c3);
  }
  .sk-empty p { margin: 0 0 12px; }
  .sk-hint { font-size: 11.5px; margin-top: 8px !important; }
  .sk-hint code {
    background: rgba(90,110,160,0.15);
    padding: 2px 7px; border-radius: 3px;
    font-size: 95%;
  }

  /* Responsive: toolbar stacks on narrow drawers */
  @media (max-width: 900px) {
    .sk-toolbar {
      grid-template-columns: 1fr;
    }
  }

  /* ── MCPs tab — discover + custom ──────────────────────────── */
  .mcp-section-head {
    display: flex; align-items: center; gap: 8px;
    margin: 6px 2px 8px;
  }
  .mcp-section-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
    text-transform: uppercase; color: var(--muted, #a8b5d1);
  }
  .mcp-section-n {
    font-size: 10px; background: rgba(90,110,160,0.18);
    padding: 1px 7px; border-radius: 10px;
    color: var(--muted, #8fa0c3); font-family: 'Fira Code', monospace;
  }
  .mcp-section-hint {
    font-size: 11px; color: var(--muted, #8fa0c3); margin-left: auto;
  }

  .mcp-discover-toggle {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    background: rgba(99,102,241,0.05);
    border: 1px dashed rgba(99,102,241,0.35);
    border-radius: 8px;
    cursor: pointer;
    margin-top: 14px;
    user-select: none;
    transition: background 0.12s, border-color 0.12s;
  }
  .mcp-discover-toggle:hover {
    background: rgba(99,102,241,0.08);
    border-color: rgba(99,102,241,0.6);
  }
  .mcp-dt-caret {
    font-size: 9px; color: var(--muted, #8fa0c3);
    transition: transform 0.15s;
    width: 12px;
  }
  .mcp-dt-caret.open { transform: rotate(90deg); color: #a3b3ff; }
  .mcp-dt-title { font-weight: 700; font-size: 13px; color: var(--fg, #e8ecf5); }
  .mcp-dt-sub { font-size: 11px; color: var(--muted, #8fa0c3); margin-left: auto; font-family: 'Fira Code', monospace; }

  .mcp-discover {
    margin-top: 10px;
    padding: 14px;
    background: var(--panel-bg, rgba(18,22,38,0.4));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.15));
    border-radius: 8px;
  }

  .mcp-discover-toolbar {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
    align-items: center;
    margin-bottom: 12px;
  }
  .mcp-search-wrap { min-width: 220px; }
  .mcp-cat-chips { flex-wrap: wrap; }

  .mcp-catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 10px;
  }

  .mcp-cat-card {
    display: flex; flex-direction: column;
    padding: 12px 14px;
    background: var(--panel-bg, rgba(18,22,38,0.6));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.2));
    border-radius: 8px;
    transition: border-color 0.12s;
  }
  .mcp-cat-card:hover { border-color: rgba(99,102,241,0.4); }
  .mcp-cat-card.installed {
    border-color: rgba(61,214,140,0.45);
    background: rgba(61,214,140,0.04);
  }
  .mcp-cat-head {
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .mcp-cat-title { font-weight: 700; font-size: 13px; color: var(--fg, #e8ecf5); }
  .mcp-cat-slug {
    font-size: 10.5px; color: var(--muted, #8fa0c3);
    font-family: 'Fira Code', monospace;
  }
  .mcp-cat-cat {
    font-size: 9px; padding: 2px 8px; border-radius: 10px;
    background: rgba(99,102,241,0.12); color: #a3b3ff;
    letter-spacing: 0.04em; text-transform: uppercase;
    font-family: 'Fira Code', monospace;
    margin-left: auto;
  }
  .mcp-cat-desc {
    font-size: 12px; line-height: 1.5;
    color: var(--muted, #a8b5d1);
    margin: 4px 0;
  }
  .mcp-cat-meta {
    display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
    margin: 6px 0;
  }
  .mcp-cat-tr {
    font-size: 9px; font-weight: 700; padding: 2px 7px; border-radius: 10px;
    letter-spacing: 0.05em; text-transform: uppercase;
    font-family: 'Fira Code', monospace;
  }
  .mcp-tr-stdio {
    background: rgba(234,139,0,0.1); color: #f5a623;
    border: 1px solid rgba(234,139,0,0.3);
  }
  .mcp-tr-http {
    background: rgba(61,172,230,0.1); color: #5bb4e8;
    border: 1px solid rgba(61,172,230,0.3);
  }
  .mcp-cat-cmd {
    font-size: 10.5px; font-family: 'Fira Code', monospace;
    background: rgba(90,110,160,0.1); padding: 2px 6px; border-radius: 3px;
    color: rgba(200,210,240,0.85);
    word-break: break-all;
    flex: 1;
  }
  .mcp-cat-req {
    display: flex; align-items: center; gap: 5px;
    font-size: 10.5px; color: #f5a623;
    padding: 4px 8px; margin: 4px 0;
    background: rgba(245,166,35,0.08);
    border-radius: 4px;
  }
  .mcp-cat-actions {
    display: flex; justify-content: flex-end; gap: 6px;
    margin-top: auto; padding-top: 8px;
  }
  .mcp-cat-link {
    font-size: 11px; color: var(--muted, #8fa0c3);
    text-decoration: none;
    padding: 5px 10px; border-radius: 4px;
    align-self: center;
  }
  .mcp-cat-link:hover { color: #a3b3ff; }
  .mcp-cat-btn {
    background: #6366f1; color: #fff; border: none;
    padding: 6px 14px; border-radius: 4px;
    cursor: pointer; font-size: 11.5px; font-weight: 600;
    transition: background 0.12s;
  }
  .mcp-cat-btn:hover { background: #5558e3; }
  .mcp-cat-btn-off {
    background: transparent; color: #ff8080;
    border: 1px solid rgba(255,128,128,0.35);
  }
  .mcp-cat-btn-off:hover {
    background: rgba(255,128,128,0.08);
    border-color: rgba(255,128,128,0.6);
  }

  /* Custom MCP form */
  .mcp-custom {
    margin-top: 18px;
    padding: 14px;
    background: var(--panel-bg, rgba(18,22,38,0.4));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.15));
    border-radius: 8px;
  }
  .mcp-custom-head {
    display: flex; align-items: center;
    margin-bottom: 10px;
  }
  .mcp-custom-row { display: flex; gap: 8px; margin-bottom: 8px; }
  .mcp-field {
    display: flex; flex-direction: column; gap: 3px;
    font-size: 11px; color: var(--muted, #8fa0c3);
    flex: 1;
  }
  .mcp-field-sm { flex: 0 0 140px; }
  .mcp-field span code {
    background: rgba(90,110,160,0.14); padding: 1px 5px; border-radius: 3px;
    font-size: 95%;
  }
  .mcp-field input, .mcp-field select {
    background: var(--panel-bg, rgba(18,22,38,0.8));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.3));
    color: inherit;
    padding: 7px 10px; border-radius: 4px;
    font-size: 12px;
    font-family: 'Fira Code', monospace;
  }
  .mcp-field input:focus, .mcp-field select:focus {
    outline: none; border-color: #6366f1;
  }
  .mcp-custom-err {
    margin-top: 6px; padding: 8px 12px; border-radius: 4px;
    background: rgba(239,68,68,0.12);
    border: 1px solid rgba(239,68,68,0.3);
    color: #ef4444; font-size: 11.5px;
  }
  .mcp-custom-actions { display: flex; justify-content: flex-end; margin-top: 10px; }

  /* ── Explanatory note used on plugins + skills tabs ─────────── */
  .plug-note {
    background: rgba(99,102,241,0.05);
    border: 1px dashed rgba(99,102,241,0.3);
    border-radius: 8px;
    padding: 10px 14px;
    margin-bottom: 12px;
    font-size: 11.5px;
    color: var(--muted, #a8b5d1);
    line-height: 1.6;
  }
  .plug-note b { color: var(--fg, #e8ecf5); }
  .plug-note code {
    background: rgba(90,110,160,0.15);
    padding: 1px 6px; border-radius: 3px; font-size: 95%;
    font-family: 'Fira Code', monospace;
  }

  /* ── MCP two-tier scope cards ───────────────────────────────── */
  .mcp-scope-card {
    background: var(--panel-bg, rgba(18,22,38,0.5));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.2));
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 12px;
  }
  .mcp-scope-user { border-left: 3px solid #10b981; }
  .mcp-scope-agent { border-left: 3px solid #6366f1; }
  .mcp-scope-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    margin-bottom: 10px;
  }
  .mcp-scope-title { font-weight: 700; font-size: 13px; color: var(--fg, #e8ecf5); display: block; }
  .mcp-scope-sub {
    display: block; font-size: 11px; color: var(--muted, #8fa0c3); margin-top: 2px; line-height: 1.5;
  }
  .mcp-scope-sub code { background: rgba(90,110,160,0.14); padding: 1px 5px; border-radius: 3px; font-family: 'Fira Code', monospace; font-size: 95%; }
  .mcp-scope-n {
    font-family: 'Fira Code', monospace;
    font-size: 13px; font-weight: 700;
    color: var(--fg, #e8ecf5);
    background: rgba(99,102,241,0.14);
    padding: 3px 10px; border-radius: 10px;
    flex-shrink: 0;
  }
  .mcp-scope-user .mcp-scope-n { background: rgba(16,185,129,0.14); color: #10b981; }
  .mcp-scope-list { display: flex; flex-direction: column; gap: 6px; }
  .mcp-row {
    display: grid; grid-template-columns: 1fr auto 28px;
    gap: 10px; align-items: center;
    padding: 8px 10px;
    background: var(--panel-bg, rgba(18,22,38,0.8));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.15));
    border-radius: 5px;
  }
  .mcp-row-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .mcp-row-dot {
    width: 6px; height: 6px; border-radius: 50%; background: #10b981; flex-shrink: 0;
  }
  .mcp-scope-agent .mcp-row-dot { background: #6366f1; }
  .mono { font-family: 'Fira Code', monospace; font-size: 12px; color: var(--fg, #e8ecf5); font-weight: 600; }
  .mcp-row-type {
    font-size: 9px; padding: 2px 6px; border-radius: 8px;
    background: rgba(90,110,160,0.2); color: var(--muted, #8fa0c3);
    text-transform: uppercase; letter-spacing: 0.04em;
    font-family: 'Fira Code', monospace;
  }
  .mcp-row-cmd {
    font-size: 10.5px; font-family: 'Fira Code', monospace;
    color: rgba(168,181,209,0.75);
    background: rgba(90,110,160,0.08); padding: 2px 6px; border-radius: 3px;
    max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .mcp-row-remove {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(120,140,200,0.25));
    color: var(--muted, #8fa0c3);
    width: 26px; height: 26px; border-radius: 4px;
    cursor: pointer; font-size: 15px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
  }
  .mcp-row-remove:hover { color: #ff8080; border-color: rgba(255,128,128,0.45); }
  .mcp-scope-empty {
    font-size: 11.5px; color: var(--muted, #8fa0c3);
    padding: 12px 4px; font-style: italic;
  }

  /* Scope picker in discover panel */
  .mcp-scope-picker {
    display: flex; align-items: center; gap: 6px;
    margin-bottom: 12px;
    padding: 8px 10px;
    background: var(--panel-bg, rgba(18,22,38,0.55));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.18));
    border-radius: 6px;
  }
  .mcp-scope-picker-label {
    font-size: 11.5px; color: var(--muted, #8fa0c3); font-weight: 600;
    margin-right: 4px;
  }
  .mcp-scope-picker button {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(120,140,200,0.25));
    color: var(--muted, #8fa0c3);
    padding: 6px 12px; border-radius: 5px;
    cursor: pointer; font-size: 11.5px; font-weight: 600;
    transition: all 0.12s;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .mcp-scope-picker button:hover { color: var(--fg, #e8ecf5); border-color: rgba(99,102,241,0.5); }
  .mcp-scope-picker button.active {
    border-color: rgba(99,102,241,0.8);
    background: rgba(99,102,241,0.12);
    color: var(--fg, #e8ecf5);
  }
  .mcp-scope-picker-sub { font-weight: 400; font-size: 10px; color: var(--muted, #8fa0c3); font-family: 'Fira Code', monospace; }
  .mcp-scope-picker button.active .mcp-scope-picker-sub { color: rgba(163,179,255,0.8); }

  /* Installed badge on catalog cards */
  .mcp-cat-installed { margin: 4px 0; }
  .mcp-cat-installed-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    display: inline-flex; align-items: center; gap: 4px;
    letter-spacing: 0.03em; font-weight: 600;
  }
  .mcp-cat-installed-user { background: rgba(16,185,129,0.12); color: #10b981; border: 1px solid rgba(16,185,129,0.28); }
  .mcp-cat-installed-agent { background: rgba(99,102,241,0.12); color: #a3b3ff; border: 1px solid rgba(99,102,241,0.28); }

  /* ── Plugins card (user-scope toggle + agent bind-mount filter) ── */
  .plug-card {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 12px 14px;
    background: var(--panel-bg, rgba(18,22,38,0.5));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.2));
    border-radius: 8px;
  }
  .plug-card.user-enabled { border-left: 3px solid #10b981; }
  .plug-card-body { flex: 1; min-width: 0; }
  .plug-card-head {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .plug-name { font-weight: 700; font-size: 13px; color: var(--fg, #e8ecf5); font-family: 'Fira Code', monospace; }
  .plug-mk {
    font-size: 10px; background: rgba(90,110,160,0.15);
    padding: 2px 8px; border-radius: 10px; color: var(--muted, #8fa0c3);
    font-family: 'Fira Code', monospace;
  }
  .plug-badge {
    font-size: 9px; padding: 2px 7px; border-radius: 10px;
    letter-spacing: 0.03em; font-weight: 600;
  }
  .plug-badge-user { background: rgba(16,185,129,0.12); color: #10b981; border: 1px solid rgba(16,185,129,0.28); }
  .plug-badge-agent { background: rgba(99,102,241,0.12); color: #a3b3ff; border: 1px solid rgba(99,102,241,0.28); }
  .plug-desc {
    font-size: 11.5px; color: var(--muted, #a8b5d1); line-height: 1.5;
    margin: 4px 0;
  }
  .plug-card-actions {
    display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; align-items: flex-end;
  }
  .plug-toggle-btn {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(120,140,200,0.3));
    color: var(--muted, #8fa0c3);
    padding: 6px 12px; border-radius: 5px;
    cursor: pointer; font-size: 11px; font-weight: 600;
    white-space: nowrap;
  }
  .plug-toggle-btn:hover { color: var(--fg, #e8ecf5); border-color: rgba(16,185,129,0.5); }
  .plug-toggle-btn.active {
    background: rgba(16,185,129,0.12);
    border-color: rgba(16,185,129,0.6);
    color: #10b981;
  }
  .plug-agent-toggle {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 10.5px; color: var(--muted, #8fa0c3); cursor: pointer;
  }
  .plug-agent-toggle input { cursor: pointer; }

  /* ── Clean unified header: agent + config mode ─────────────── */
  .hdr {
    display: flex; align-items: center;
    gap: 16px;
    padding: 10px 14px;
    margin-bottom: 4px;
    background: var(--panel-bg, rgba(18,22,38,0.6));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.22));
    border-radius: 10px;
  }
  .hdr-slot { display: flex; align-items: center; gap: 10px; }
  .hdr-label {
    font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
    color: var(--muted, #8fa0c3); text-transform: uppercase;
  }
  .hdr-select {
    background: var(--panel-bg, rgba(18,22,38,0.9));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.28));
    color: var(--fg, #e8ecf5);
    padding: 6px 28px 6px 10px; border-radius: 6px;
    font-size: 13px; font-weight: 600; font-family: 'Fira Code', monospace;
    min-width: 220px;
    cursor: pointer;
    appearance: none;
    background-image: linear-gradient(45deg, transparent 50%, rgba(160,170,200,0.6) 50%),
                      linear-gradient(135deg, rgba(160,170,200,0.6) 50%, transparent 50%);
    background-position: calc(100% - 12px) 50%, calc(100% - 8px) 50%;
    background-size: 4px 4px;
    background-repeat: no-repeat;
  }
  .hdr-select:focus { outline: none; border-color: rgba(99,102,241,0.6); }

  .hdr-sep { width: 1px; height: 26px; background: var(--panel-border, rgba(90,110,160,0.22)); }

  .hdr-mode-tabs { display: inline-flex; background: rgba(90,110,160,0.08); border-radius: 6px; padding: 2px; }
  .hdr-mode {
    background: transparent;
    border: none;
    color: var(--muted, #a8b5d1);
    padding: 6px 14px; border-radius: 4px;
    cursor: pointer; font-size: 12px; font-weight: 600;
    transition: all 0.12s;
  }
  .hdr-mode:hover { color: var(--fg, #e8ecf5); }
  .hdr-mode.active {
    background: var(--panel-bg, rgba(18,22,38,0.9));
    color: var(--fg, #e8ecf5);
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  }

  .hdr-actions { margin-left: auto; display: flex; align-items: center; gap: 10px; }
  .hdr-copy {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(120,140,200,0.28));
    color: var(--muted, #a8b5d1);
    padding: 6px 12px; border-radius: 6px;
    cursor: pointer; font-size: 12px; font-weight: 600;
    transition: all 0.12s;
    white-space: nowrap;
  }
  .hdr-copy:hover:not(:disabled) {
    border-color: rgba(99,102,241,0.5);
    color: var(--fg, #e8ecf5);
  }
  .hdr-copy:disabled { opacity: 0.4; cursor: not-allowed; }

  .hdr-caption {
    font-size: 11.5px; color: var(--muted, #8fa0c3);
    line-height: 1.55;
    margin: 8px 4px 16px;
    padding: 0 4px;
  }
  .hdr-caption b { color: var(--fg, #e8ecf5); }
  .hdr-caption code {
    background: rgba(90,110,160,0.14); padding: 1px 6px; border-radius: 3px;
    font-family: 'Fira Code', monospace; font-size: 95%;
  }

  /* ── Clean unified MCPs list ─────────────────────────────── */
  .mcp-head-row {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px;
    padding: 0 2px;
  }
  .mcp-head-title {
    margin: 0 0 3px; font-size: 14px; font-weight: 700;
    color: var(--fg, #e8ecf5); letter-spacing: -0.01em;
  }
  .mcp-head-sub { font-size: 11px; color: var(--muted, #8fa0c3); font-family: 'Fira Code', monospace; }

  .mcp-empty-box {
    padding: 32px 20px; text-align: center;
    background: var(--panel-bg, rgba(18,22,38,0.3));
    border: 1px dashed var(--panel-border, rgba(90,110,160,0.2));
    border-radius: 10px;
    color: var(--muted, #8fa0c3);
  }
  .mcp-empty-box p { margin: 0 0 4px; font-size: 13px; }
  .mcp-empty-sub { font-size: 11.5px !important; color: rgba(150,170,210,0.55); }

  .mcp-list-clean { display: flex; flex-direction: column; gap: 6px; }

  .mcp-item {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 12px;
    align-items: center;
    padding: 10px 14px;
    background: var(--panel-bg, rgba(18,22,38,0.45));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.18));
    border-radius: 8px;
    transition: border-color 0.12s, background 0.12s;
  }
  .mcp-item:hover { border-color: rgba(99,102,241,0.35); }
  .mcp-item-shared { border-left: 3px solid #10b981; }
  .mcp-item-agent { border-left: 3px solid #a3b3ff; }

  .mcp-item-origin {
    font-size: 15px;
    display: flex; align-items: center; justify-content: center;
    width: 28px; height: 28px;
    border-radius: 6px;
    background: rgba(90,110,160,0.08);
    cursor: help;
  }

  .mcp-item-main { min-width: 0; }
  .mcp-item-name {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin-bottom: 2px;
  }
  .mcp-item-name .mono {
    font-size: 13px; color: var(--fg, #e8ecf5); font-weight: 700;
  }
  .mcp-item-type {
    font-size: 9px; padding: 2px 7px; border-radius: 8px;
    background: rgba(90,110,160,0.16); color: var(--muted, #8fa0c3);
    text-transform: uppercase; letter-spacing: 0.04em;
    font-family: 'Fira Code', monospace;
  }
  .mcp-item-cmd {
    font-size: 10.5px; font-family: 'Fira Code', monospace;
    color: rgba(168,181,209,0.7);
    display: block;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .mcp-item-remove {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(120,140,200,0.22));
    color: var(--muted, #8fa0c3);
    width: 28px; height: 28px; border-radius: 6px;
    cursor: pointer; font-size: 16px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.12s;
  }
  .mcp-item-remove:hover {
    color: #ff8080;
    border-color: rgba(255,128,128,0.45);
    background: rgba(255,128,128,0.06);
  }

  /* ── Per-agent private workspace (plugins/skills) ──────────── */
  .priv-section {
    margin: 10px 0 18px;
    padding: 12px 14px;
    background: rgba(245,166,35,0.05);
    border: 1px dashed rgba(245,166,35,0.35);
    border-radius: 8px;
  }
  .priv-head {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 8px;
  }
  .priv-title {
    font-size: 12px; font-weight: 700; color: var(--fg, #e8ecf5);
  }
  .priv-count {
    font-size: 10px; background: rgba(245,166,35,0.18);
    padding: 1px 7px; border-radius: 10px;
    color: #f5a623;
    font-family: 'Fira Code', monospace;
  }
  .priv-empty {
    font-size: 11.5px; color: var(--muted, #a8b5d1);
    line-height: 1.5;
  }
  .priv-empty b {
    color: var(--fg, #e8ecf5);
    background: rgba(245,166,35,0.12);
    padding: 1px 6px; border-radius: 3px;
  }
  .priv-list { display: flex; flex-direction: column; gap: 5px; }
  .priv-item {
    display: grid;
    grid-template-columns: minmax(140px, auto) 1fr 28px;
    gap: 10px;
    align-items: center;
    padding: 6px 10px;
    background: var(--panel-bg, rgba(18,22,38,0.6));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.2));
    border-radius: 5px;
  }
  .priv-item .mono {
    font-size: 12px; font-weight: 700; color: var(--fg, #e8ecf5);
  }
  .priv-path {
    font-size: 10px; font-family: 'Fira Code', monospace;
    color: rgba(168,181,209,0.55);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    background: rgba(90,110,160,0.08); padding: 2px 6px; border-radius: 3px;
  }
  .priv-remove {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(120,140,200,0.22));
    color: var(--muted, #8fa0c3);
    width: 24px; height: 24px; border-radius: 4px;
    cursor: pointer; font-size: 14px; line-height: 1;
  }
  .priv-remove:hover { color: #ff8080; border-color: rgba(255,128,128,0.45); }

  /* Copy-private action inside plugin cards */
  .plug-copy-private {
    background: transparent;
    border: 1px solid rgba(245,166,35,0.35);
    color: #f5a623;
    padding: 6px 12px; border-radius: 5px;
    cursor: pointer; font-size: 11px; font-weight: 600;
    white-space: nowrap;
    transition: all 0.12s;
  }
  .plug-copy-private:hover:not(:disabled) {
    background: rgba(245,166,35,0.08);
    border-color: rgba(245,166,35,0.6);
  }
  .plug-copy-private.active {
    background: rgba(245,166,35,0.14);
    color: #f5a623;
    border-color: rgba(245,166,35,0.6);
  }
  .plug-copy-private:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Private skill badge + per-card action */
  .sk-badge-priv {
    background: rgba(245,166,35,0.12);
    color: #f5a623;
    border: 1px solid rgba(245,166,35,0.3);
  }
  .sk-card-private {
    border-left: 2px solid rgba(245,166,35,0.5);
  }
  .sk-card-priv-actions {
    margin-top: 6px;
    display: flex; gap: 6px;
  }
  .sk-priv-btn {
    background: transparent;
    border: 1px solid rgba(245,166,35,0.35);
    color: #f5a623;
    padding: 4px 10px; border-radius: 4px;
    cursor: pointer; font-size: 10.5px; font-weight: 600;
    white-space: nowrap;
  }
  .sk-priv-btn:hover {
    background: rgba(245,166,35,0.08);
    border-color: rgba(245,166,35,0.6);
  }
  .sk-priv-btn.active {
    background: rgba(245,166,35,0.14);
  }

  .card {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 12px;
    background: var(--panel-bg, rgba(18,22,38,0.6));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.2));
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s;
  }
  .card:hover { border-color: rgba(99,102,241,0.4); }
  .card.active { border-color: rgba(99,102,241,0.8); background: rgba(99,102,241,0.08); }

  .card input[type=checkbox] { margin-top: 3px; cursor: pointer; flex-shrink: 0; }
  .card-body { flex: 1; min-width: 0; }
  .card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
  .card-head .name { font-weight: 700; font-size: 13px; color: var(--fg, #e8ecf5); }
  .tag {
    font-size: 9px;
    background: rgba(90,110,160,0.15);
    padding: 2px 7px; border-radius: 8px;
    color: var(--muted, #8fa0c3);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-family: 'Fira Code', monospace;
  }
  .desc { font-size: 11.5px; color: var(--muted, #a8b5d1); margin: 4px 0; line-height: 1.5; }
  .path { font-size: 10px; color: rgba(150,170,210,0.6); font-family: 'Fira Code', monospace; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .provides { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 6px; }
  .prov-pill {
    font-size: 10px;
    background: rgba(99,102,241,0.12);
    padding: 2px 7px; border-radius: 4px;
    color: #a3b3ff;
  }

  .muted { padding: 40px; text-align: center; color: var(--muted, #8fa0c3); font-size: 13px; }
  .muted a { color: #7c92ff; text-decoration: underline; }
  .err-banner {
    background: rgba(239,68,68,0.12);
    border: 1px solid #ef4444;
    color: #ef4444;
    padding: 10px 14px; border-radius: 4px;
    margin-bottom: 10px;
    display: flex; justify-content: space-between;
  }
  .err-banner button { background: none; border: none; color: inherit; cursor: pointer; font-size: 16px; }

  .mp-add {
    background: var(--panel-bg, rgba(18,22,38,0.6));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.2));
    border-radius: 6px;
    padding: 14px 16px;
    margin-bottom: 16px;
  }
  .mp-add label { display: block; font-size: 11px; color: var(--muted, #8fa0c3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .mp-add-row { display: flex; gap: 8px; }
  .mp-add input[type=url] {
    flex: 1;
    background: var(--panel-bg, rgba(18,22,38,0.8));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.3));
    color: inherit;
    padding: 7px 12px; border-radius: 4px;
    font-size: 12px;
    font-family: 'Fira Code', monospace;
  }
  .mp-add input[type=url]:focus { outline: none; border-color: #6366f1; }
  .btn-primary {
    background: #6366f1; color: #fff; border: none;
    padding: 7px 16px; border-radius: 4px;
    cursor: pointer; font-size: 12px; font-weight: 600;
    display: flex; align-items: center; gap: 4px;
  }
  .btn-primary:hover:not(:disabled) { background: #5558e3; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .mp-hint { margin: 10px 0 0; font-size: 11px; color: var(--muted, #8fa0c3); line-height: 1.5; }
  .mp-hint code { background: rgba(90,110,160,0.14); padding: 1px 5px; border-radius: 3px; font-size: 95%; }

  .mp-list { display: flex; flex-direction: column; gap: 8px; }
  .mp-card {
    display: flex; justify-content: space-between; align-items: flex-start; gap: 14px;
    padding: 12px 16px;
    background: var(--panel-bg, rgba(18,22,38,0.6));
    border: 1px solid var(--panel-border, rgba(90,110,160,0.2));
    border-radius: 6px;
  }
  .mp-card-main { flex: 1; min-width: 0; }
  .mp-title { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
  .mp-name { font-weight: 700; font-size: 14px; color: var(--fg, #e8ecf5); }
  .mp-dirname { font-size: 11px; color: var(--muted, #8fa0c3); font-family: 'Fira Code', monospace; }
  .mp-count {
    font-size: 10px; background: rgba(99,102,241,0.15); color: #a3b3ff;
    padding: 2px 8px; border-radius: 10px; font-family: 'Fira Code', monospace;
  }
  .mp-desc { margin: 4px 0; font-size: 12px; color: var(--muted, #a8b5d1); line-height: 1.5; }
  .mp-url {
    font-size: 10px; font-family: 'Fira Code', monospace;
    color: rgba(150,170,210,0.6); display: inline-block; margin-top: 2px;
  }
  .mp-last { font-size: 10.5px; color: var(--muted, #8fa0c3); font-family: 'Fira Code', monospace; margin-top: 3px; }
  .mp-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .btn-sm {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(120,140,200,0.3));
    color: var(--muted, #8fa0c3);
    padding: 6px 10px; border-radius: 4px;
    cursor: pointer; font-size: 13px;
    min-width: 32px;
    display: flex; align-items: center; justify-content: center;
  }
  .btn-sm:hover:not(:disabled) { color: var(--fg, #e8ecf5); border-color: rgba(120,140,200,0.5); }
  .btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-sm.btn-danger { color: #ff8080; border-color: rgba(255,128,128,0.35); }
  .btn-sm.btn-danger:hover:not(:disabled) { color: #ff8080; border-color: rgba(255,128,128,0.7); background: rgba(255,128,128,0.08); }

  .toast-stack {
    position: fixed; bottom: 16px; right: 16px;
    display: flex; flex-direction: column; gap: 8px;
    z-index: 1000; pointer-events: none;
  }
  .toast {
    display: flex; gap: 10px; padding: 10px 14px;
    background: var(--panel-bg, #0f1326);
    border: 1px solid #10b981;
    border-left: 3px solid #10b981;
    border-radius: 4px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.35);
    min-width: 220px;
    animation: popin 0.18s ease-out;
  }
  @keyframes popin { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  .toast.err { border-color: #ef4444; border-left-color: #ef4444; }
  .toast .ic { font-weight: 700; color: #10b981; }
  .toast.err .ic { color: #ef4444; }
  .t-title { font-size: 12px; font-weight: 700; }
  .t-sub { font-size: 11px; color: var(--muted, #a8b5d1); }
</style>

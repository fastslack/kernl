/**
 * Smart auto-categorization for subscriptions.
 * Matches by name/provider keywords against well-known service patterns.
 */

interface CategoryRule {
  category: string;
  keywords: string[];
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: 'streaming-video',
    keywords: ['netflix', 'disney', 'hbo', 'hulu', 'prime video', 'amazon prime', 'apple tv', 'paramount', 'peacock', 'crunchyroll', 'youtube premium', 'mubi', 'plex', 'fubo', 'sling'],
  },
  {
    category: 'streaming-music',
    keywords: ['spotify', 'apple music', 'tidal', 'deezer', 'pandora', 'amazon music', 'youtube music', 'soundcloud', 'qobuz'],
  },
  {
    category: 'cloud-storage',
    keywords: ['dropbox', 'google one', 'icloud', 'onedrive', 'mega', 'box', 'pcloud', 'sync.com', 'backblaze'],
  },
  {
    category: 'productivity',
    keywords: ['notion', 'evernote', 'todoist', 'trello', 'asana', 'clickup', 'monday', 'airtable', 'obsidian', 'roam', 'craft', 'reflect', 'logseq'],
  },
  {
    category: 'office-suite',
    keywords: ['microsoft 365', 'office 365', 'google workspace', 'g suite', 'libreoffice', 'zoho'],
  },
  {
    category: 'developer-tools',
    keywords: ['github', 'gitlab', 'bitbucket', 'jetbrains', 'intellij', 'pycharm', 'webstorm', 'vercel', 'netlify', 'heroku', 'railway', 'render', 'fly.io', 'digitalocean', 'linode', 'vultr', 'cloudflare', 'aws', 'azure', 'gcp', 'firebase', 'supabase', 'planetscale', 'mongodb atlas', 'sentry', 'datadog', 'new relic', 'codespaces', 'replit', 'codepen'],
  },
  {
    category: 'ai-llm',
    keywords: ['openai', 'chatgpt', 'anthropic', 'claude', 'gemini', 'midjourney', 'perplexity', 'copilot', 'cursor', 'windsurf', 'mistral', 'replicate', 'huggingface', 'runway', 'eleven labs', 'elevenlabs', 'pika', 'leonardo'],
  },
  {
    category: 'design',
    keywords: ['figma', 'adobe', 'creative cloud', 'photoshop', 'illustrator', 'canva', 'sketch', 'invision', 'framer', 'penpot', 'affinity', 'procreate'],
  },
  {
    category: 'communication',
    keywords: ['slack', 'discord', 'zoom', 'teams', 'mattermost', 'rocket.chat', 'telegram premium', 'whatsapp business', 'signal'],
  },
  {
    category: 'email',
    keywords: ['protonmail', 'fastmail', 'tutanota', 'hey.com', 'mailbox', 'zoho mail', 'mxroute'],
  },
  {
    category: 'vpn-security',
    keywords: ['nordvpn', 'expressvpn', 'mullvad', 'protonvpn', 'surfshark', 'private internet access', 'pia', 'cyberghost', 'windscribe', '1password', 'lastpass', 'bitwarden', 'dashlane', 'keeper'],
  },
  {
    category: 'news-media',
    keywords: ['nyt', 'new york times', 'wsj', 'wall street journal', 'economist', 'financial times', 'medium', 'substack', 'bloomberg', 'wired', 'guardian'],
  },
  {
    category: 'fitness-health',
    keywords: ['gym', 'fitness', 'peloton', 'strava', 'fitbit', 'whoop', 'oura', 'myfitnesspal', 'noom', 'headspace', 'calm', 'apple fitness', 'nike training', 'classpass'],
  },
  {
    category: 'gaming',
    keywords: ['xbox game pass', 'game pass', 'playstation plus', 'ps plus', 'nintendo switch online', 'ea play', 'ubisoft+', 'geforce now', 'humble', 'steam', 'epic games'],
  },
  {
    category: 'education',
    keywords: ['udemy', 'coursera', 'pluralsight', 'linkedin learning', 'masterclass', 'skillshare', 'duolingo', 'babbel', 'rosetta stone', 'brilliant', 'khan academy', 'codecademy', 'frontend masters', 'egghead'],
  },
  {
    category: 'social-media',
    keywords: ['twitter blue', 'x premium', 'linkedin premium', 'reddit premium', 'instagram', 'tiktok', 'snapchat+'],
  },
  {
    category: 'finance',
    keywords: ['ynab', 'mint', 'personal capital', 'quickbooks', 'xero', 'freshbooks', 'wave', 'rocket money', 'truebill', 'monarch'],
  },
  {
    category: 'home-utilities',
    keywords: ['electricity', 'water', 'gas', 'internet', 'fiber', 'mobile', 'phone', 'movistar', 'vodafone', 'orange', 'comcast', 'verizon', 'at&t', 'spectrum'],
  },
  {
    category: 'food-delivery',
    keywords: ['uber eats', 'doordash', 'grubhub', 'glovo', 'deliveroo', 'rappi', 'just eat', 'pedidosya', 'instacart', 'hellofresh', 'blue apron'],
  },
  {
    category: 'transport',
    keywords: ['uber', 'lyft', 'cabify', 'lime', 'bird', 'tier', 'voi', 'tesla supercharger'],
  },
];

/** Auto-categorize a subscription based on its name and provider */
export function autoCategorize(name: string, provider: string = ''): string {
  const haystack = `${name} ${provider}`.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (haystack.includes(kw)) return rule.category;
    }
  }
  return 'other';
}

/** Get all known categories */
export function knownCategories(): string[] {
  return CATEGORY_RULES.map(r => r.category).concat(['other']);
}

/** Group of related categories — for high-level breakdowns */
export const CATEGORY_GROUPS: Record<string, string[]> = {
  'Entertainment': ['streaming-video', 'streaming-music', 'gaming', 'news-media', 'social-media'],
  'Work & Productivity': ['productivity', 'office-suite', 'developer-tools', 'ai-llm', 'design', 'communication', 'email'],
  'Living': ['home-utilities', 'food-delivery', 'transport', 'fitness-health'],
  'Cloud & Security': ['cloud-storage', 'vpn-security'],
  'Learning & Finance': ['education', 'finance'],
  'Other': ['other'],
};

/** Get the high-level group for a category */
export function categoryGroup(category: string): string {
  for (const [group, cats] of Object.entries(CATEGORY_GROUPS)) {
    if (cats.includes(category)) return group;
  }
  return 'Other';
}

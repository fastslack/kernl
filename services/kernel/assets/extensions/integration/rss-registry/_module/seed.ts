/**
 * Built-in seed catalog. Loaded on first init when the registry is empty.
 * Curated for quality; users can add/remove freely afterwards.
 */

export interface SeedCategory {
  name: string;
  icon: string;
  description: string;
}

export interface SeedFeed {
  name: string;
  slug: string;
  category: string;
  feed_url: string;
  website_url: string;
  description: string;
  language: string;
  country: string;
  update_frequency: "realtime" | "hourly" | "daily" | "weekly";
  tags: string;
  quality_score: number;
}

export const SEED_CATEGORIES: SeedCategory[] = [
  { name: "Tech", icon: "💻", description: "Software, hardware, internet" },
  { name: "Programming", icon: "⌨️", description: "Languages, frameworks, dev culture" },
  { name: "AI", icon: "🤖", description: "Machine learning, AI research, LLMs" },
  { name: "Science", icon: "🔬", description: "Research, discoveries, physics, biology" },
  { name: "Business", icon: "💼", description: "Markets, startups, economics" },
  { name: "World", icon: "🌍", description: "International news" },
  { name: "Design", icon: "🎨", description: "Product, UX, visual design" },
  { name: "Security", icon: "🛡️", description: "Cybersecurity, vulnerabilities, infosec" },
  { name: "Culture", icon: "🎭", description: "Arts, ideas, long-form essays" },
];

export const SEED_FEEDS: SeedFeed[] = [
  // Tech
  {
    name: "Hacker News",
    slug: "hacker-news",
    category: "Tech",
    feed_url: "https://news.ycombinator.com/rss",
    website_url: "https://news.ycombinator.com",
    description: "Top stories on Hacker News, the community curated tech feed.",
    language: "en", country: "US", update_frequency: "hourly",
    tags: "tech,community,startups", quality_score: 90,
  },
  {
    name: "Ars Technica",
    slug: "ars-technica",
    category: "Tech",
    feed_url: "https://feeds.arstechnica.com/arstechnica/index",
    website_url: "https://arstechnica.com",
    description: "In-depth reporting on tech, science, and policy.",
    language: "en", country: "US", update_frequency: "daily",
    tags: "tech,science,policy", quality_score: 85,
  },
  {
    name: "The Verge",
    slug: "the-verge",
    category: "Tech",
    feed_url: "https://www.theverge.com/rss/index.xml",
    website_url: "https://www.theverge.com",
    description: "Tech, science, art, and culture from The Verge.",
    language: "en", country: "US", update_frequency: "hourly",
    tags: "tech,gadgets,culture", quality_score: 80,
  },
  {
    name: "MIT Technology Review",
    slug: "mit-tech-review",
    category: "Tech",
    feed_url: "https://www.technologyreview.com/feed/",
    website_url: "https://www.technologyreview.com",
    description: "MIT's deep tech analysis publication.",
    language: "en", country: "US", update_frequency: "daily",
    tags: "tech,research,analysis", quality_score: 88,
  },

  // Programming
  {
    name: "GitHub Blog",
    slug: "github-blog",
    category: "Programming",
    feed_url: "https://github.blog/feed/",
    website_url: "https://github.blog",
    description: "Engineering, security, and product updates from GitHub.",
    language: "en", country: "US", update_frequency: "daily",
    tags: "github,engineering,opensource", quality_score: 82,
  },
  {
    name: "Stack Overflow Blog",
    slug: "stack-overflow-blog",
    category: "Programming",
    feed_url: "https://stackoverflow.blog/feed/",
    website_url: "https://stackoverflow.blog",
    description: "Developer culture and survey insights from Stack Overflow.",
    language: "en", country: "US", update_frequency: "weekly",
    tags: "developers,community,career", quality_score: 78,
  },
  {
    name: "Martin Fowler",
    slug: "martin-fowler",
    category: "Programming",
    feed_url: "https://martinfowler.com/feed.atom",
    website_url: "https://martinfowler.com",
    description: "Software design articles and refactoring patterns.",
    language: "en", country: "UK", update_frequency: "weekly",
    tags: "architecture,patterns,refactoring", quality_score: 92,
  },

  // AI
  {
    name: "Anthropic News",
    slug: "anthropic-news",
    category: "AI",
    feed_url: "https://www.anthropic.com/news/rss.xml",
    website_url: "https://www.anthropic.com/news",
    description: "Announcements and research from Anthropic.",
    language: "en", country: "US", update_frequency: "weekly",
    tags: "ai,claude,research", quality_score: 95,
  },
  {
    name: "OpenAI Blog",
    slug: "openai-blog",
    category: "AI",
    feed_url: "https://openai.com/blog/rss.xml",
    website_url: "https://openai.com/blog",
    description: "OpenAI announcements, research, and product updates.",
    language: "en", country: "US", update_frequency: "weekly",
    tags: "ai,gpt,research", quality_score: 90,
  },
  {
    name: "Hugging Face Blog",
    slug: "huggingface-blog",
    category: "AI",
    feed_url: "https://huggingface.co/blog/feed.xml",
    website_url: "https://huggingface.co/blog",
    description: "Open-source AI tooling and model releases.",
    language: "en", country: "US", update_frequency: "daily",
    tags: "ai,opensource,models", quality_score: 87,
  },

  // Science
  {
    name: "Quanta Magazine",
    slug: "quanta",
    category: "Science",
    feed_url: "https://api.quantamagazine.org/feed/",
    website_url: "https://www.quantamagazine.org",
    description: "Illuminating fundamental science and mathematics.",
    language: "en", country: "US", update_frequency: "daily",
    tags: "physics,math,biology,research", quality_score: 95,
  },
  {
    name: "Nature News",
    slug: "nature-news",
    category: "Science",
    feed_url: "https://www.nature.com/nature.rss",
    website_url: "https://www.nature.com",
    description: "Top scientific news from Nature.",
    language: "en", country: "UK", update_frequency: "daily",
    tags: "science,research,nature", quality_score: 93,
  },

  // Business
  {
    name: "Stratechery",
    slug: "stratechery",
    category: "Business",
    feed_url: "https://stratechery.com/feed/",
    website_url: "https://stratechery.com",
    description: "Ben Thompson on tech strategy and business.",
    language: "en", country: "US", update_frequency: "daily",
    tags: "strategy,tech-business,analysis", quality_score: 92,
  },
  {
    name: "Marginal Revolution",
    slug: "marginal-revolution",
    category: "Business",
    feed_url: "https://marginalrevolution.com/feed",
    website_url: "https://marginalrevolution.com",
    description: "Economics blog by Tyler Cowen and Alex Tabarrok.",
    language: "en", country: "US", update_frequency: "daily",
    tags: "economics,policy,books", quality_score: 88,
  },

  // World
  {
    name: "BBC World",
    slug: "bbc-world",
    category: "World",
    feed_url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    website_url: "https://www.bbc.com/news/world",
    description: "International news from the BBC.",
    language: "en", country: "UK", update_frequency: "hourly",
    tags: "news,international,bbc", quality_score: 85,
  },
  {
    name: "Reuters World",
    slug: "reuters-world",
    category: "World",
    feed_url: "https://feeds.reuters.com/Reuters/worldNews",
    website_url: "https://www.reuters.com/world",
    description: "World news from Reuters.",
    language: "en", country: "US", update_frequency: "hourly",
    tags: "news,international,reuters", quality_score: 86,
  },

  // Design
  {
    name: "Smashing Magazine",
    slug: "smashing-magazine",
    category: "Design",
    feed_url: "https://www.smashingmagazine.com/feed/",
    website_url: "https://www.smashingmagazine.com",
    description: "Web design, UX, and front-end development articles.",
    language: "en", country: "DE", update_frequency: "weekly",
    tags: "ux,webdesign,frontend", quality_score: 84,
  },
  {
    name: "A List Apart",
    slug: "alistapart",
    category: "Design",
    feed_url: "https://alistapart.com/main/feed/",
    website_url: "https://alistapart.com",
    description: "For people who make websites.",
    language: "en", country: "US", update_frequency: "weekly",
    tags: "webdesign,standards,craft", quality_score: 86,
  },

  // Security
  {
    name: "Krebs on Security",
    slug: "krebs",
    category: "Security",
    feed_url: "https://krebsonsecurity.com/feed/",
    website_url: "https://krebsonsecurity.com",
    description: "Investigative cybercrime reporting by Brian Krebs.",
    language: "en", country: "US", update_frequency: "daily",
    tags: "security,cybercrime,investigation", quality_score: 91,
  },
  {
    name: "The Hacker News",
    slug: "the-hacker-news",
    category: "Security",
    feed_url: "https://feeds.feedburner.com/TheHackersNews",
    website_url: "https://thehackernews.com",
    description: "Cybersecurity news, vulnerabilities, and breach reports.",
    language: "en", country: "US", update_frequency: "hourly",
    tags: "security,cve,breaches", quality_score: 78,
  },

  // Culture
  {
    name: "Aeon",
    slug: "aeon",
    category: "Culture",
    feed_url: "https://aeon.co/feed.rss",
    website_url: "https://aeon.co",
    description: "Long-form essays on philosophy, science, and culture.",
    language: "en", country: "UK", update_frequency: "daily",
    tags: "philosophy,essays,longform", quality_score: 90,
  },
  {
    name: "Longreads",
    slug: "longreads",
    category: "Culture",
    feed_url: "https://longreads.com/feed/",
    website_url: "https://longreads.com",
    description: "The best long-form writing on the web.",
    language: "en", country: "US", update_frequency: "daily",
    tags: "longform,essays,journalism", quality_score: 87,
  },
];

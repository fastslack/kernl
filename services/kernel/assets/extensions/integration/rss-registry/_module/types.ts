export type UpdateFrequency = "realtime" | "hourly" | "daily" | "weekly";
export type FeedStatus = "active" | "disabled" | "error" | "dead";

export interface RssCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
}

export interface RssFeed {
  id: string;
  name: string;
  slug: string;
  description: string;
  category_id: string | null;
  feed_url: string;
  website_url: string;
  language: string;
  country: string;
  update_frequency: UpdateFrequency;
  status: FeedStatus;
  last_check_at: string | null;
  last_check_ok: number | null;
  last_item_at: string | null;
  item_count: number;
  error_count: number;
  error_message: string;
  tags: string;
  quality_score: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface RssFeedWithCategory extends RssFeed {
  category_name: string | null;
  category_icon: string | null;
}

export interface RssItem {
  id: string;
  feed_id: string;
  guid: string;
  title: string;
  link: string;
  author: string;
  description: string;
  content: string;
  image_url: string;
  published_at: string | null;
  fetched_at: string;
  hash: string;
}

export interface RssItemWithFeed extends RssItem {
  feed_name: string;
  feed_slug: string;
  feed_url: string;
  category_id: string | null;
  category_name: string | null;
  category_icon: string | null;
  language: string;
}

export interface FeedAddInput {
  name: string;
  slug?: string;
  description?: string;
  category_id?: string | null;
  feed_url: string;
  website_url?: string;
  language?: string;
  country?: string;
  update_frequency?: UpdateFrequency;
  tags?: string[];
  quality_score?: number;
}

export interface FeedUpdateInput {
  name?: string;
  description?: string;
  category_id?: string | null;
  feed_url?: string;
  website_url?: string;
  language?: string;
  country?: string;
  update_frequency?: UpdateFrequency;
  status?: FeedStatus;
  tags?: string[];
  quality_score?: number;
  sort_order?: number;
}

export interface CategoryAddInput {
  name: string;
  description?: string;
  icon?: string;
  parent_id?: string | null;
  sort_order?: number;
}

export interface FeedListQuery {
  category_id?: string;
  status?: FeedStatus;
  language?: string;
  country?: string;
  min_quality?: number;
  limit?: number;
  offset?: number;
}

export interface FeedSearchQuery {
  query: string;
  category_id?: string;
  language?: string;
  limit?: number;
}

export interface ItemListQuery {
  feed_id?: string;
  category_id?: string;
  language?: string;
  since?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ValidationResult {
  valid: boolean;
  feed_url: string;
  title?: string;
  item_count?: number;
  last_item_date?: string;
  response_time_ms?: number;
  error?: string;
}

export interface FetchResult {
  feed_id: string;
  ok: boolean;
  new_items: number;
  total_items: number;
  error?: string;
}

export interface RegistryStats {
  total_feeds: number;
  active_feeds: number;
  error_feeds: number;
  by_category: Array<{ category: string; count: number }>;
  by_language: Array<{ language: string; count: number }>;
  by_frequency: Array<{ frequency: string; count: number }>;
  avg_quality_score: number;
  total_items: number;
  items_last_24h: number;
}

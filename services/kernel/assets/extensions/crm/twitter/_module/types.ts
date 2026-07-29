// ── Database row types ─────────────────────────────

export interface TwitterAccountRow {
  id: string;
  handle: string;
  display_name: string;
  api_key: string;
  api_secret: string;
  access_token: string;
  access_secret: string;
  status: string; // 'active' | 'paused' | 'suspended'
  // v2 — multi-driver + campaign metadata
  driver: string; // 'api' | 'xactions'
  auth_cookie_ref: string; // vault key when driver='xactions'; e.g. 'x-cookie/kernl'
  last_login_at: string; // ISO timestamp of last successful x_login probe
  voice_persona: string; // free-text voice rules baked into content-creator prompt
  role: string; // 'brand' | 'founder' | 'community' | 'support' | 'other'
  partner_account_id: string; // sibling account in a coordinated orbit (never cross-RT)
  created_at: string;
  updated_at: string;
}

export interface TwitterPostRow {
  id: string;
  account_id: string;
  content: string;
  post_type: string; // 'tweet' | 'reply' | 'thread' | 'quote'
  status: string; // 'draft' | 'queued' | 'approved' | 'posted' | 'failed'
  scheduled_at: string | null;
  posted_at: string | null;
  x_post_id: string;
  reply_to_x_id: string;
  quote_x_id: string;
  metrics_impressions: number;
  metrics_likes: number;
  metrics_retweets: number;
  metrics_replies: number;
  error_message: string;
  // v2 — campaign tagging + auditor output
  format: string; // 'native_video' | 'gif' | 'image' | 'text' | 'thread' | 'self_reply'
  signal_target: string; // 'reply' | 'quote' | 'dwell' | 'video_view' | 'bookmark' | ...
  phase: string; // 'foundation' | 'seeding' | 'authority' | 'launch' | 'capitalize' | 'sustain' | 'crisis_recovery'
  campaign_anchor: number; // 1 if from a scripted anchor; 0 if free-generated
  audit_score: number; // 0-100, set by Algorithm Auditor; 0 means not yet audited
  audit_notes: string; // free-text issues raised by the auditor
  parent_post_id: string | null; // for thread tweets / self-replies
  created_at: string;
  updated_at: string;
}

export interface TwitterPostAnalyticsRow {
  id: string;
  post_id: string;
  snapshot_at: string;
  impressions: number;
  oon_impressions: number;
  oon_pct: number;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  profile_clicks: number;
  mute_count: number;
  block_count: number;
  mute_rate: number;
  engagement_rate: number;
  created_at: string;
}

export interface TwitterAccountStateRow {
  account_id: string;
  phase: string;
  phase_started_at: string;
  oon_pct_7d: number;
  mute_rate_7d: number;
  crisis_triggered_at: string;
  updated_at: string;
}

export interface TwitterMentionRow {
  id: string;
  account_id: string;
  x_post_id: string;
  author_handle: string;
  author_name: string;
  content: string;
  replied: number; // 0 | 1
  reply_post_id: string | null;
  detected_at: string;
  created_at: string;
}

export interface TwitterMetricsSnapshotRow {
  id: string;
  account_id: string;
  followers: number;
  following: number;
  tweets_count: number;
  snapshot_date: string;
  created_at: string;
}

export type ContentFormat =
  | "insight"
  | "thread"
  | "question"
  | "hot_take"
  | "curated_list"
  | "story"
  | "tip";

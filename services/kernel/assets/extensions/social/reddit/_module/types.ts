export interface RedditAccountRow {
  id: string;
  username: string;
  client_id: string;
  client_secret: string;
  password: string;
  user_agent: string;
  access_token: string;
  token_expires_at: string | null;
  role: "brand" | "founder" | "community" | "other";
  status: "active" | "disabled" | "locked" | "banned";
  karma_comment: number;
  karma_post: number;
  created_at: string;
  updated_at: string;
}

export interface RedditPostRow {
  id: string;
  account_id: string;
  subreddit: string;
  title: string;
  body: string;
  url: string;
  kind: "self" | "link" | "image";
  status: "draft" | "scheduled" | "published" | "failed" | "removed";
  scheduled_for: string | null;
  published_at: string | null;
  reddit_id: string;
  permalink: string;
  upvotes: number;
  comments_count: number;
  error: string;
  created_at: string;
  updated_at: string;
}

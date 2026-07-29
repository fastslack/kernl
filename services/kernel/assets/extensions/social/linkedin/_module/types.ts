export interface LinkedInAccountRow {
  id: string;
  urn: string;
  display_name: string;
  account_type: "person" | "organization";
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string | null;
  role: "brand" | "founder" | "community" | "other";
  status: "active" | "disabled" | "suspended";
  created_at: string;
  updated_at: string;
}

export interface LinkedInPostRow {
  id: string;
  account_id: string;
  text: string;
  kind: "text" | "article" | "image";
  article_url: string;
  article_title: string;
  article_desc: string;
  image_path: string;
  visibility: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
  status: "draft" | "scheduled" | "published" | "failed";
  scheduled_for: string | null;
  published_at: string | null;
  post_urn: string;
  impressions: number;
  likes: number;
  comments_count: number;
  shares: number;
  error: string;
  created_at: string;
  updated_at: string;
}

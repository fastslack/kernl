export interface YouTubeAccountRow {
  id: string;
  channel_id: string;
  channel_title: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token: string;
  token_expires_at: string | null;
  role: "brand" | "founder" | "community" | "other";
  status: "active" | "disabled" | "suspended";
  subscribers: number;
  total_views: number;
  total_videos: number;
  created_at: string;
  updated_at: string;
}

export interface YouTubeVideoRow {
  id: string;
  account_id: string;
  video_id: string;
  title: string;
  description: string;
  tags: string;
  category_id: string;
  privacy: "public" | "unlisted" | "private";
  status: "draft" | "uploading" | "uploaded" | "failed";
  file_path: string;
  upload_url: string;
  views: number;
  likes: number;
  comments_count: number;
  published_at: string | null;
  error: string;
  created_at: string;
  updated_at: string;
}

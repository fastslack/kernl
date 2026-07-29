export type ResourceType = "book" | "article" | "course" | "paper" | "podcast" | "video" | "other";
export type ResourceStatus = "wishlist" | "in_progress" | "completed" | "abandoned" | "paused";
export type HighlightType = "highlight" | "note" | "quote" | "action_item" | "question";

export interface LearningResource {
  id: string;
  type: ResourceType;
  title: string;
  author: string;
  url: string;
  isbn: string;
  source: string;
  status: ResourceStatus;
  priority: "low" | "medium" | "high";
  rating: number | null;
  started_at: string | null;
  completed_at: string | null;
  total_pages: number;
  current_page: number;
  total_hours: number;
  spent_hours: number;
  tags: string; // JSON
  notes: string;
  summary: string;
  created_at: string;
  updated_at: string;
}

export interface LearningHighlight {
  id: string;
  resource_id: string;
  content: string;
  location: string;
  type: HighlightType;
  created_at: string;
}

export interface LearningFlashcard {
  id: string;
  resource_id: string | null;
  deck: string;
  front: string;
  back: string;
  tags: string; // JSON
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  next_review: string;
  last_reviewed: string | null;
  created_at: string;
  updated_at: string;
}

export interface LearningReview {
  id: string;
  card_id: string;
  quality: number; // 0-5
  reviewed_at: string;
}

export interface LearningGoal {
  id: string;
  title: string;
  description: string;
  target_date: string | null;
  status: "active" | "completed" | "abandoned";
  created_at: string;
  updated_at: string;
}

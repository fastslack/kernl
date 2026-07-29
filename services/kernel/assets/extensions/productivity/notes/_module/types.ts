export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string; // comma-separated
  pinned: number; // 0 | 1
  contact_id: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

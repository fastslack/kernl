export type AgendaItem = {
  id: string;
  type: 'task' | 'event' | 'reminder';
  title: string;
  daysUntilDue: number | null;
  priority: 'urgent' | 'high' | 'medium' | 'low' | null;
  tags: string;
};
export type ScoredItem = AgendaItem & { score: number; why: string };
export type TodayPlan = { date: string; items: ScoredItem[]; counts: { overdue: number; dueToday: number } };

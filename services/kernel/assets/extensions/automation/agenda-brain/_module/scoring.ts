import type { AgendaItem, ScoredItem } from './types.js';

export function urgency(daysUntilDue: number | null): number {
  if (daysUntilDue === null) return 5;
  if (daysUntilDue < 0) return 100;
  if (daysUntilDue === 0) return 80;
  if (daysUntilDue === 1) return 60;
  if (daysUntilDue <= 3) return 40;
  if (daysUntilDue <= 7) return 20;
  return 10;
}

const PRIORITY: Record<string, number> = { urgent: 40, high: 25, medium: 10, low: 0 };
export function priorityWeight(p: string | null): number {
  return p ? (PRIORITY[p] ?? 0) : 0;
}

export function scoreItem(item: AgendaItem, activeTags: Set<string>): ScoredItem {
  const u = urgency(item.daysUntilDue);
  const pw = priorityWeight(item.priority);
  const itemTags = item.tags ? item.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const hitTag = itemTags.find((t) => activeTags.has(t));
  const boost = hitTag ? 20 : 0;

  const reasons: string[] = [];
  if (item.priority === 'urgent') reasons.push('urgent');
  else if (item.priority === 'high') reasons.push('high priority');
  if (item.daysUntilDue !== null) {
    if (item.daysUntilDue < 0) reasons.push(`${-item.daysUntilDue}d overdue`);
    else if (item.daysUntilDue === 0) reasons.push('due today');
    else if (item.daysUntilDue === 1) reasons.push('due tomorrow');
    else if (item.daysUntilDue <= 7) reasons.push(`due in ${item.daysUntilDue}d`);
  }
  if (hitTag) reasons.push(`part of ${hitTag.replace('-', ' ')}`);

  return { ...item, score: u + pw + boost, why: reasons.join(' · ') || 'not urgent' };
}

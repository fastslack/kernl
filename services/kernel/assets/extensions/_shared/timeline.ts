// Timeline chip colours, keyed by item type. Mirrors TL_COLORS in
// services/dashboard/src/lib/constants.ts; read by DayModal and the events
// planner page.

export const TL_COLORS: Record<string, string> = {
  task: '#5B9BF7', reminder: '#F0883E', subscription: '#3DD68C',
  health: '#F04770', maintenance: '#D4A84B', vehicle: '#D4A84B',
  document: '#6E738A', goal: '#3DD6C8', meal: '#da7756',
  research: '#8B7CF6', event: '#E879A8', cache: '#6E738A',
  interval: '#3DD6C8', watcher: '#D4A84B', listener: '#F0883E',
  automation: '#8B7CF6'
};

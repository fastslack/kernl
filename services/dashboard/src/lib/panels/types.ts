// src/lib/panels/types.ts
/** The panels.v1 shapes the dashboard renders (the kernel owns validation). */
export type Text = string | { es?: string; en?: string };
export interface LiteSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  properties?: Record<string, LiteSchema>;
  required?: string[];
  items?: LiteSchema;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  title?: Text;
  visibleIf?: Record<string, unknown>;
}
export interface PanelView {
  id: string; title: Text; icon?: string;
  component: 'table' | 'board' | 'detail' | 'form' | 'timeline';
  data?: string; join?: Record<string, string>; columns?: string; order?: string[]; counts?: string;
  fields?: Array<{ key: string; label?: Text; sub?: string }>;
  card?: { title: string; subtitle?: string; badges?: string[]; links?: Array<{ label: Text; href: string }> };
  detail?: string; sections?: string[]; actions?: string[]; action?: string; time?: string; text?: string;
}
export interface PanelAction { type: 'letter' | 'run' | 'record' | 'schedule'; label: Text; input?: LiteSchema; confirm?: Text }
export interface PanelSpec { version: 1; sources: Record<string, { type: string }>; views: PanelView[]; anchors?: Array<{ object: string; view: string }>; actions?: Record<string, PanelAction> }

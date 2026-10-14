// src/lib/panels/form-model.ts
import type { LiteSchema } from './types.js';
import { textOf } from './template.js';

export interface FormField {
  key: string; label: string; kind: 'text' | 'number' | 'select' | 'checkbox' | 'textarea';
  options?: string[]; required: boolean; visibleIf?: Record<string, unknown>; pattern?: string;
}

export function formFields(schema: LiteSchema | undefined, locale: string): FormField[] {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([key, p]) => {
    const kind: FormField['kind'] = p.enum ? 'select'
      : p.type === 'boolean' ? 'checkbox'
      : p.type === 'number' || p.type === 'integer' ? 'number'
      : (p.maxLength ?? 0) > 200 ? 'textarea' : 'text';
    return {
      key, kind, label: textOf(p.title, locale) || key, required: required.has(key),
      ...(p.enum ? { options: p.enum.map(String) } : {}),
      ...(p.visibleIf ? { visibleIf: p.visibleIf } : {}),
      ...(p.pattern ? { pattern: p.pattern } : {}),
    };
  });
}

export function isVisible(f: Pick<FormField, 'visibleIf'>, values: Record<string, unknown>): boolean {
  return Object.entries(f.visibleIf ?? {}).every(([k, v]) => values[k] === v);
}

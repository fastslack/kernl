// src/modules/panels/jsonschema-lite.ts
/**
 * The JSON Schema subset panels use: for the state files offices keep and for
 * action forms. Small on purpose — a panel spec is data the kernel must check,
 * and a full validator would be a new dependency for a handful of keywords.
 */
export interface LiteSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  properties?: Record<string, LiteSchema>;
  required?: string[];
  items?: LiteSchema;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  title?: string | { es?: string; en?: string };
  /** Form only: the field shows (and is required) when every listed field has that value. */
  visibleIf?: Record<string, unknown>;
  /** Never leaves the kernel. */
  secret?: boolean;
}

const at = (path: string, msg: string) => `${path || "(root)"}: ${msg}`;

export function validateLite(schema: LiteSchema, value: unknown, path = ""): string[] {
  const errs: string[] = [];
  if (value === undefined) return errs;
  const t = schema.type;
  if (t === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [at(path, "must be an object")];
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined || obj[key] === "") errs.push(at(path ? `${path}.${key}` : key, "required"));
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      errs.push(...validateLite(sub, obj[key], path ? `${path}.${key}` : key));
    }
    return errs;
  }
  if (t === "array") {
    if (!Array.isArray(value)) return [at(path, "must be an array")];
    if (schema.items) value.forEach((v, i) => errs.push(...validateLite(schema.items!, v, `${path}[${i}]`)));
    return errs;
  }
  if (t === "string" && typeof value !== "string") return [at(path, "must be a string")];
  if ((t === "number" || t === "integer") && (typeof value !== "number" || !Number.isFinite(value))) return [at(path, "must be a number")];
  if (t === "integer" && !Number.isInteger(value)) return [at(path, "must be an integer")];
  if (t === "boolean" && typeof value !== "boolean") return [at(path, "must be true or false")];
  if (schema.enum && !schema.enum.includes(value)) errs.push(at(path, `must be one of ${schema.enum.join(", ")}`));
  if (typeof value === "string") {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(at(path, `longer than ${schema.maxLength}`));
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(at(path, "has the wrong format"));
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(at(path, `below ${schema.minimum}`));
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(at(path, `above ${schema.maximum}`));
  }
  return errs;
}

function visible(field: LiteSchema, values: Record<string, unknown>): boolean {
  return Object.entries(field.visibleIf ?? {}).every(([k, v]) => values[k] === v);
}

/** Form values as the kernel will act on them: typed, only declared and visible fields. */
export function coerceFormValues(schema: LiteSchema, raw: Record<string, unknown>): { values: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = {};
  const props = schema.properties ?? {};
  for (const [key, field] of Object.entries(props)) {
    let v = raw[key];
    if (v === undefined || v === null || v === "") continue;
    if ((field.type === "number" || field.type === "integer") && typeof v === "string" && v.trim() !== "") v = Number(v);
    if (field.type === "boolean" && typeof v === "string") v = v === "true";
    if (field.type === "string" && typeof v !== "string") v = String(v);
    values[key] = v;
  }
  for (const [key, field] of Object.entries(props)) {
    if (!visible(field, values)) delete values[key];
  }
  const visibleRequired = (schema.required ?? []).filter((k) => props[k] && visible(props[k], values));
  const errors = validateLite({ ...schema, required: visibleRequired }, values);
  return { values, errors };
}

export function stripSecrets(schema: LiteSchema | undefined, value: unknown): unknown {
  if (!schema || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return schema.items ? value.map((v) => stripSecrets(schema.items, v)) : value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const sub = schema.properties?.[k];
    if (sub?.secret) continue;
    out[k] = stripSecrets(sub, v);
  }
  return out;
}

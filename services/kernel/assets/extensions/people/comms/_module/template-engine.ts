/**
 * Simple template engine for email personalization.
 *
 * Syntax: {{variable_name}}
 *
 * Built-in variables (from CRM contact):
 *   {{name}}       — full name
 *   {{first_name}} — first word of name
 *   {{email}}      — email address
 *   {{company}}    — company name
 *
 * Custom variables are provided per-recipient as a JSON object.
 * Unresolved variables are left as-is (not replaced).
 */

export interface TemplateContext {
  name?: string;
  email?: string;
  company?: string;
  [key: string]: string | undefined;
}

const VAR_PATTERN = /\{\{(\w+)\}\}/g;

export function renderTemplate(template: string, context: TemplateContext): string {
  const vars: Record<string, string> = {};

  // Built-in derived variables
  if (context.name) {
    vars.name = context.name;
    vars.first_name = context.name.split(/\s+/)[0];
  }
  if (context.email) vars.email = context.email;
  if (context.company) vars.company = context.company;

  // Custom variables override built-ins
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) vars[key] = value;
  }

  return template.replace(VAR_PATTERN, (match, varName: string) => {
    return vars[varName] ?? match;
  });
}

/**
 * Extract variable names from a template string.
 */
export function extractVariables(template: string): string[] {
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  const pattern = new RegExp(VAR_PATTERN.source, "g");
  while ((match = pattern.exec(template)) !== null) {
    vars.add(match[1]);
  }
  return [...vars];
}

/**
 * Merge subject + body variables into a deduplicated list.
 */
export function detectTemplateVariables(subject: string, body: string, bodyHtml?: string): string[] {
  const vars = new Set<string>();
  for (const v of extractVariables(subject)) vars.add(v);
  for (const v of extractVariables(body)) vars.add(v);
  if (bodyHtml) {
    for (const v of extractVariables(bodyHtml)) vars.add(v);
  }
  return [...vars];
}

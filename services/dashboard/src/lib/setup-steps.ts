/**
 * Which steps of the first-run wizard (/setup) a signed-in principal gets.
 *
 * Most steps configure the install, not the person: the edition, the AI
 * provider, the mail accounts and the WhatsApp session all live behind
 * system modules the kernel only grants by name (core/permissions.ts). A user
 * without those grants used to walk into the step, click, and stop on a 403
 * with no way forward. The kernel stays the judge; this only keeps the wizard
 * from offering what would be refused.
 *
 * `null` session (auth disabled, or /api/auth/me unreachable) and the super
 * admin get every step, exactly as before users existed.
 */
import { can, canCreateInAgents, type Session } from './session.js';

export type SetupStep = 'lang' | 'edition' | 'llm' | 'team' | 'mail' | 'whatsapp' | 'done';

/** Wizard order. The page indexes into this. */
export const SETUP_STEPS: readonly SetupStep[] = ['lang', 'edition', 'llm', 'team', 'mail', 'whatsapp', 'done'];

export interface SetupContext {
  /** The AI step was left without a provider: no model to hire a team with. */
  aiSkipped: boolean;
  /** Kernel readiness verdict (`/api/llm/readiness`); null = unknown. */
  llmReady: boolean | null;
}

/** Whether this principal may do what the step saves. */
export function canDoSetupStep(s: Session | null, step: SetupStep): boolean {
  switch (step) {
    case 'lang':
    case 'done':
      return true; // the language is kept in this browser; done saves nothing
    case 'edition':
      return can(s, 'edition', 'write');
    case 'llm':
      return can(s, 'llm', 'write');
    case 'team':
      return canCreateInAgents(s);
    case 'mail':
      return can(s, 'email-accounts', 'write');
    case 'whatsapp':
      return can(s, 'channels', 'write');
  }
}

/** The steps this principal walks through, in order. */
export function visibleSetupSteps(s: Session | null, ctx: SetupContext): SetupStep[] {
  return SETUP_STEPS.filter((step) => {
    if (!canDoSetupStep(s, step)) return false;
    if (step === 'team') {
      // Hiring greets the team with a real model call. Whoever set up the AI
      // here and skipped it has none; whoever could not set it up depends on
      // the admin having done so, and only the kernel's verdict says that.
      if (ctx.aiSkipped) return false;
      if (!canDoSetupStep(s, 'llm') && ctx.llmReady !== true) return false;
    }
    return true;
  });
}

/** Whether the closing checklist (settings + provider catalog) is readable. */
export function canSeeSetupChecklist(s: Session | null): boolean {
  return can(s, 'settings', 'read') || can(s, 'llm', 'read');
}

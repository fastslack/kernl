/**
 * Which project a chat with an agent is about.
 *
 * Every run, memory entry and inbox letter is kept apart per project in the
 * kernel; a chat turn that carries no project lands in the shared no-project
 * bucket, and an agent working for two projects mixes them there. So the chat
 * names its project: the one its office works for, or — in an office that
 * works for several, or for whichever project calls it (a shared office like
 * Ventas) — the one picked in the tab.
 */

export interface ChatProject {
  slug: string;
  name: string;
}

interface OfficeProjectsResponse {
  projects?: Array<{ active?: boolean; project?: { slug?: string; name?: string; status?: string } }>;
  serves_any?: boolean;
}

interface ProjectsResponse {
  projects?: Array<{ slug?: string; name?: string; status?: string }>;
}

const clean = (rows: Array<{ slug?: string; name?: string; status?: string } | undefined>): ChatProject[] =>
  rows.flatMap((p) => (p?.slug && (p.status ?? 'active') === 'active' ? [{ slug: p.slug, name: p.name || p.slug }] : []));

/** The projects a chat in this office can be about. */
export function chatProjectChoices(office: OfficeProjectsResponse | null, all: ProjectsResponse | null): ChatProject[] {
  if (office?.serves_any) return clean(all?.projects ?? []);
  return clean((office?.projects ?? []).filter((o) => o.active !== false).map((o) => o.project));
}

/** The project to start on: the only one, else the last picked if still offered, else none. */
export function defaultChatProject(choices: ChatProject[], saved: string | null): string {
  if (choices.length === 1) return choices[0].slug;
  return saved && choices.some((c) => c.slug === saved) ? saved : '';
}

export const chatProjectKey = (agentId: string) => `kernl.chatProject.${agentId}`;

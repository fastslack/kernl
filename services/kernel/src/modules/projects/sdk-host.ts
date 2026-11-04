import type { ProjectsHost, ProjectInfo } from "../../sdk/projects.js";
import type { ProjectsService } from "./projects-service.js";
import type { OutboxService } from "./outbox-service.js";
import type { Project } from "./types.js";
import type { ProjectAccountsService } from "./accounts.js";
import { claimState, exchangeCode, isProjectState } from "./google-link.js";
import { getRequestContext } from "../../core/request-context.js";

type RecordsFn = (projectId: string, kind: string) => Array<{ external_id: string; data: unknown; updated_at: string }>;

const info = (p: Project): ProjectInfo => ({
  id: p.id, slug: p.slug, name: p.name, status: p.status, brief: p.brief as unknown as Record<string, unknown>,
});

/** The projects module as extensions see it through `@kernl/extension-sdk`. */
export function projectsHostFor(
  svc: ProjectsService, outbox: OutboxService, records: RecordsFn,
  accounts?: ProjectAccountsService | null, ofRepo?: (pathOrRemote: string) => string | undefined,
): ProjectsHost {
  return {
    get: (idOrSlug) => { const p = svc.get(idOrSlug); return p ? info(p) : undefined; },
    current: () => {
      const id = svc.runProjectId(getRequestContext().callerRunId);
      const p = id ? svc.get(id) : undefined;
      return p ? info(p) : undefined;
    },
    list: (filter) => svc.list({ flowId: filter?.flowId }).map(info),
    records: (projectId, kind) => records(projectId, kind),
    officeSettings: (flowId, projectId) => svc.officeSettings(flowId, projectId),
    registerOutboxChannel: (channel, handler) => outbox.registerChannel(channel, handler),
    registerOutboxPolicy: (name, fn) => outbox.registerPolicy(name, fn),
    unregisterOutboxPolicy: (name) => outbox.unregisterPolicy(name),
    ofRepo: (pathOrRemote) => ofRepo?.(pathOrRemote),
    accountEnv: (projectId) => accounts?.env(projectId) ?? {},
    account: (projectId, provider) => {
      const a = accounts?.get(projectId, provider);
      return a ? { config: a.config, secrets: a.secrets, identity: a.identity } : undefined;
    },
    isGoogleLinkState: (state) => isProjectState(state),
    completeGoogleLink: async (state, code) => {
      const projectId = claimState(state);
      if (!projectId || !accounts) return { ok: false, error: "El enlace con Google venció o no es de este Kernl: volvé a tocar «Conectar con Google»" };
      try {
        const { refreshToken, email } = await exchangeCode(code, fetch);
        accounts.linkGoogle(projectId, refreshToken, email);
        return { ok: true };
      } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    },
    propose: (item) => outbox.propose({
      project_id: item.project_id, flow_id: item.flow_id, agent_id: item.agent_id ?? "", run_id: item.run_id ?? "",
      channel: item.channel, account_ref: item.account_ref, payload: item.payload, scheduled_for: item.scheduled_for ?? null,
    }),
  };
}

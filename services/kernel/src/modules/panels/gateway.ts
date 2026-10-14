// src/modules/panels/gateway.ts
/**
 * The only door between a panel and the kernel. Reads declared sources;
 * runs declared actions — validated, rate-limited and audited.
 */
import { readSource, SourceError } from "./sources.js";
import { renderTemplate, TemplateError } from "./template.js";
import { coerceFormValues } from "./jsonschema-lite.js";
import { selectPath, SelectorError } from "./select.js";
import type { PanelStore } from "./store.js";
import type { PanelAction, PanelSpec } from "./spec.js";

export const RATE_MIN_GAP_MS = 3000;
export const RATE_PER_HOUR = 20;

export class PanelError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface PanelDeps {
  agentInOffice(flowId: string, slug: string): { id: string; name: string; active: boolean } | null;
  postLetter(input: { toAgentId: string; subject: string; body: string }): { ok: boolean; error?: string };
  startRun(input: { agentId: string; goal: string }): { runId: string };
  setSchedulesActive(agentId: string, active: boolean): number;
  now?: () => number;
}

const SIGNATURE = "\n\n— Enviado por el operador desde el panel de la oficina.";

export class PanelGateway {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly store: PanelStore, private readonly deps: PanelDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  private load(flowId: string): { spec: PanelSpec; rootDir: string; updatedAt: string } {
    const s = this.store.getSpec(flowId);
    if (!s) throw new PanelError(404, "this office has no panels");
    return s;
  }

  spec(flowId: string): { spec: PanelSpec; updatedAt: string } | null {
    const s = this.store.getSpec(flowId);
    return s ? { spec: s.spec, updatedAt: s.updatedAt } : null;
  }

  read(flowId: string, sourceId: string, opts: { select?: string; since?: string; vars?: Record<string, unknown> } = {}):
    { version: string; data?: unknown; unchanged?: true } {
    const { spec, rootDir } = this.load(flowId);
    const src = Object.prototype.hasOwnProperty.call(spec.sources, sourceId) ? spec.sources[sourceId] : undefined;
    if (!src) throw new PanelError(403, `source "${sourceId}" is not declared by this office`);
    let res: { version: string; data: unknown };
    try { res = readSource(src, { owner: flowId, rootDir, store: this.store }); }
    catch (e) { if (e instanceof SourceError) throw new PanelError(e.status, e.message); throw e; }
    if (opts.since && opts.since === res.version) return { version: res.version, unchanged: true };
    try {
      return { version: res.version, data: opts.select ? selectPath(res.data, opts.select, opts.vars ?? {}) : res.data };
    } catch (e) {
      if (e instanceof SelectorError || e instanceof TemplateError) throw new PanelError(400, e.message);
      throw e;
    }
  }

  private rateCheck(key: string): void {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
    const last = recent[recent.length - 1];
    if (last !== undefined && now - last < RATE_MIN_GAP_MS) throw new PanelError(429, "too fast: wait a few seconds");
    if (recent.length >= RATE_PER_HOUR) throw new PanelError(429, "too many times in the last hour");
    recent.push(now);
    this.hits.set(key, recent);
  }

  private agent(flowId: string, slug: string) {
    const a = this.deps.agentInOffice(flowId, slug);
    if (!a) throw new PanelError(409, `agent "${slug}" is no longer in this office`);
    return a;
  }

  act(flowId: string, actionId: string, rawValues: Record<string, unknown>, actor: string): { ok: true; result: string } {
    const audit = (ok: boolean, result: string, values: unknown) =>
      this.store.audit({ owner: flowId, action: actionId, values, ok, result, actor });
    try {
      const { spec } = this.load(flowId);
      const action: PanelAction | undefined = spec.actions && Object.prototype.hasOwnProperty.call(spec.actions, actionId)
        ? spec.actions[actionId] : undefined;
      if (!action) throw new PanelError(403, `action "${actionId}" is not declared by this office`);
      const { values, errors } = action.input
        ? coerceFormValues(action.input, rawValues ?? {})
        : { values: {} as Record<string, unknown>, errors: [] as string[] };
      if (errors.length) throw new PanelError(400, errors.join("; "));
      this.rateCheck(`${flowId}:${actionId}`);
      const result = this.execute(flowId, action, values);
      audit(true, result, values);
      return { ok: true, result };
    } catch (e) {
      const err = e instanceof PanelError ? e
        : e instanceof TemplateError ? new PanelError(400, e.message)
        : new PanelError(500, e instanceof Error ? e.message : String(e));
      audit(false, `${err.status} ${err.message}`, rawValues ?? {});
      throw err;
    }
  }

  private execute(flowId: string, action: PanelAction, values: Record<string, unknown>): string {
    switch (action.type) {
      case "letter": {
        const to = this.agent(flowId, action.to);
        const subject = renderTemplate(action.subject, values).trim().slice(0, 200);
        if (!subject) throw new PanelError(400, "the letter subject came out empty");
        const body = (action.body ? renderTemplate(action.body, values) : "") + SIGNATURE;
        const r = this.deps.postLetter({ toAgentId: to.id, subject, body });
        if (!r.ok) throw new PanelError(502, r.error ?? "the letter was not delivered");
        return `Carta «${subject}» enviada a ${to.name}.`;
      }
      case "run": {
        const a = this.agent(flowId, action.agent);
        if (!a.active) throw new PanelError(409, `${a.name} is paused`);
        const goal = renderTemplate(action.goal, values).trim();
        const { runId } = this.deps.startRun({ agentId: a.id, goal });
        return `Corrida ${runId.slice(0, 8)} de ${a.name} en marcha.`;
      }
      case "record": {
        const key = renderTemplate(action.key, values).trim().slice(0, 200);
        if (!key) throw new PanelError(400, "the record key came out empty");
        this.store.putRecord(flowId, action.collection, key, values, "operator");
        return `Guardado en ${action.collection}.`;
      }
      case "schedule": {
        const a = this.agent(flowId, action.agent);
        const n = this.deps.setSchedulesActive(a.id, action.state === "on");
        if (n === 0) throw new PanelError(409, `${a.name} has no schedule to switch`);
        return `${n} schedule(s) de ${a.name} ${action.state === "on" ? "activados" : "pausados"}.`;
      }
    }
  }
}

import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { KernelHttpServer } from "../../core/http-server.js";
import { HttpError } from "../../sdk/http-error.js";
import type { ProjectsService } from "./projects-service.js";
import type { OutboxService } from "./outbox-service.js";
import type { ConnectorService } from "./connector-service.js";
import { ProjectBriefSchema, SLUG_RE } from "./brief.js";
import type { OutboxStatus, ProjectLinkKind, ProjectStatus } from "./types.js";

export interface ProjectsRouteDeps {
  projects: ProjectsService;
  outbox: OutboxService;
  connector: ConnectorService;
  flowName: (flowId: string) => string;
  listFlows: () => Array<{ id: string; name: string; active?: number }>;
}

const WEBHOOK_MAX_BYTES = 1024 * 1024;

const CreateBody = z.object({
  slug: z.string().regex(SLUG_RE, "slug: lowercase letters, digits and dashes"),
  name: z.string().min(1),
  brief: ProjectBriefSchema,
});
const UpdateBody = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  brief: ProjectBriefSchema.optional(),
});
const ConnectorBody = z.object({ url: z.string(), token: z.string().optional() });
const LinkBody = z.object({
  kind: z.enum(["repo", "social_account", "email_account", "task_project", "workspace"]),
  ref_id: z.string().min(1),
});
const OfficeBody = z.object({ active: z.boolean().optional(), settings: z.record(z.unknown()).optional() });
const EditBody = z.object({ payload: z.record(z.unknown()) });
const ApproveBody = z.object({ scheduled_for: z.string().nullable().optional() });
const RejectBody = z.object({ note: z.string().trim().min(1, "a reason is required to reject a draft") });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

/** Service errors → HTTP: missing → 404, wrong state → 409, anything else → 400. */
function asHttp(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(msg)) throw new HttpError(404, msg);
  if (/^Only a /.test(msg)) throw new HttpError(409, msg);
  throw new HttpError(400, msg);
}

function readRaw(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Everything the dashboard needs for /projects, /outbox and the office panel. */
export function registerProjectsRoutes(server: KernelHttpServer, deps: ProjectsRouteDeps): void {
  const { projects, outbox, connector } = deps;

  const mustProject = (idOrSlug: string) => {
    const p = projects.get(idOrSlug);
    if (!p) throw new HttpError(404, `Project not found: ${idOrSlug}`);
    return p;
  };
  const officesOf = (projectId: string) =>
    deps.listFlows().flatMap((f) => {
      const op = projects.officeProjects(f.id).find((o) => o.project_id === projectId);
      return op ? [{ flow_id: f.id, name: deps.flowName(f.id), active: op.active, settings: op.settings }] : [];
    });

  // ── Projects ───────────────────────────────────────────
  server.route("GET", "/api/projects", () => ({
    projects: projects.list().map((p) => ({
      ...p,
      pending_drafts: outbox.pendingCount(p.id),
      leads: projects.leadCount(p.id),
      offices: officesOf(p.id).map(({ flow_id, name, active }) => ({ flow_id, name, active })),
    })),
  }));

  server.route("POST", "/api/projects", ({ body }) => {
    const b = parse(CreateBody, body);
    try {
      return { project: projects.create(b) };
    } catch (err) { return asHttp(err); }
  });

  server.route("GET", "/api/projects/:id", ({ params }) => {
    const p = mustProject(params.id);
    return { project: p, links: projects.links(p.id), offices: officesOf(p.id) };
  });

  server.route("PUT", "/api/projects/:id", ({ params, body }) => {
    const p = mustProject(params.id);
    const b = parse(UpdateBody, body);
    try {
      return { project: projects.update(p.id, b as { name?: string; status?: ProjectStatus; brief?: typeof b.brief }) };
    } catch (err) { return asHttp(err); }
  });

  server.route("PUT", "/api/projects/:id/connector", ({ params, body }) => {
    const p = mustProject(params.id);
    return { project: projects.setConnector(p.id, parse(ConnectorBody, body)) };
  });

  server.route("GET", "/api/projects/:id/webhook-secret", ({ params }) => {
    const p = mustProject(params.id);
    const path = `/api/projects/webhook/${p.slug}`;
    const publicUrl = (process.env.KERNEL_PUBLIC_URL ?? "").replace(/\/$/, "");
    return { secret: projects.connectorSecrets(p.id).webhookSecret, path, url: publicUrl ? `${publicUrl}${path}` : "" };
  });

  server.route("POST", "/api/projects/:id/pull", async ({ params }) => {
    const p = mustProject(params.id);
    try {
      return await connector.pull(p.id);
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
  });

  server.route("POST", "/api/projects/:id/links", ({ params, body }) => {
    const p = mustProject(params.id);
    const b = parse(LinkBody, body);
    projects.link(p.id, b.kind as ProjectLinkKind, b.ref_id);
    return { links: projects.links(p.id) };
  });

  server.route("DELETE", "/api/projects/:id/links", ({ params, query }) => {
    const p = mustProject(params.id);
    const b = parse(LinkBody, { kind: query.get("kind"), ref_id: query.get("ref_id") });
    projects.unlink(p.id, b.kind as ProjectLinkKind, b.ref_id);
    return { links: projects.links(p.id) };
  });

  server.route("PUT", "/api/projects/:id/offices/:flowId", ({ params, body }) => {
    const p = mustProject(params.id);
    return { office: projects.assignOffice(params.flowId, p.id, parse(OfficeBody, body)) };
  });

  server.route("DELETE", "/api/projects/:id/offices/:flowId", ({ params }) => {
    const p = mustProject(params.id);
    projects.unassignOffice(params.flowId, p.id);
    return { ok: true };
  });

  server.route("GET", "/api/offices/:flowId/projects", ({ params }) => ({
    projects: projects.officeProjects(params.flowId),
    settings_schema: projects.getOfficeSettingsSchema(params.flowId),
  }));

  // ── Outbox ─────────────────────────────────────────────
  server.route("GET", "/api/outbox", ({ query }) => {
    const items = outbox.list({
      project_id: query.get("project_id") ?? undefined,
      flow_id: query.get("flow_id") ?? undefined,
      channel: query.get("channel") ?? undefined,
      status: (query.get("status") as OutboxStatus | null) ?? undefined,
      limit: Number(query.get("limit") ?? 200) || 200,
    });
    return {
      items: items.map((it) => {
        let preview: { title: string; body: string; meta?: Record<string, string> };
        try { preview = outbox.preview(it.id); } catch {
          // Channel not registered (extension off): show the draft's own text, not raw JSON.
          const p = (it.payload ?? {}) as Record<string, unknown>;
          const text = typeof p.text === "string" ? p.text : typeof p.body === "string" ? p.body : JSON.stringify(p);
          preview = { title: typeof p.subject === "string" ? p.subject : "", body: text };
        }
        return { ...it, preview };
      }),
      channels: outbox.listChannels(),
    };
  });

  server.route("GET", "/api/outbox/count", ({ query }) => ({ pending: outbox.pendingCount(query.get("project_id") ?? undefined) }));

  server.route("PUT", "/api/outbox/:id", ({ params, body }) => {
    try { return { item: outbox.edit(params.id, parse(EditBody, body).payload) }; } catch (err) {
      if (err instanceof HttpError) throw err;
      return asHttp(err);
    }
  });

  server.route("POST", "/api/outbox/:id/approve", async ({ params, body }) => {
    try { return { item: await outbox.approve(params.id, parse(ApproveBody, body)) }; } catch (err) {
      if (err instanceof HttpError) throw err;
      return asHttp(err);
    }
  });

  server.route("POST", "/api/outbox/:id/reject", ({ params, body }) => {
    const b = parse(RejectBody, body);
    try { return { item: outbox.reject(params.id, b.note) }; } catch (err) { return asHttp(err); }
  });

  server.route("POST", "/api/outbox/:id/retry", async ({ params }) => {
    try { return { item: await outbox.retry(params.id) }; } catch (err) { return asHttp(err); }
  });

  // ── Webhook (token-exempt, HMAC-authenticated; src/core/auth.ts) ──
  server.post("/api/projects/webhook/:slug", async (req, res) => {
    const slug = (req as unknown as { params?: Record<string, string> }).params?.slug ?? "";
    let raw: string;
    try {
      raw = await readRaw(req, WEBHOOK_MAX_BYTES);
    } catch {
      server.json(res, 413, { error: "body too large" }, req);
      return;
    }
    const header = req.headers["x-kernl-signature"];
    const out = connector.handleWebhook(slug, raw, Array.isArray(header) ? header[0] ?? "" : header ?? "");
    server.json(res, out.status, out.status === 200 ? { ok: true, result: out.body } : { error: out.body }, req);
  });
}

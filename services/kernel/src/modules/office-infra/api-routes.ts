import type { KernelHttpServer } from "../../core/http-server.js";
import type { OfficeEnvironmentService } from "./office-environment-service.js";

/** Register the dashboard REST surface for office environments. */
export function registerOfficeInfraRoutes(
  server: KernelHttpServer,
  service: OfficeEnvironmentService,
): void {
  // GET /api/office-env?flow_id=<id> → { config, status }
  server.get("/api/office-env", (req, res) => {
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const flowId = url.searchParams.get("flow_id") ?? "";
      if (!flowId) return server.json(res, 400, { error: "flow_id required" }, req);
      const config = service.get(flowId);
      const status = service.status(flowId);
      server.json(res, 200, { config, status }, req);
    } catch (e) {
      server.json(res, 500, { error: e instanceof Error ? e.message : String(e) }, req);
    }
  });

  // POST /api/office-env/configure
  server.post("/api/office-env/configure", async (req, res) => {
    try {
      const body = await server.parseBody<{ flow_id?: string } & Record<string, unknown>>(req);
      if (!body.flow_id) return server.json(res, 400, { error: "flow_id required" }, req);
      const { flow_id, ...patch } = body;
      const config = service.configure(flow_id, patch);
      server.json(res, 200, { config, status: service.status(flow_id) }, req);
    } catch (e) {
      server.json(res, 400, { error: e instanceof Error ? e.message : String(e) }, req);
    }
  });

  // GET /api/office-env/list → all offices' cached infra states (no docker
  // inspect) so the 3D office can paint every infra badge on load.
  server.get("/api/office-env/list", (req, res) => {
    try {
      server.json(res, 200, { offices: service.list() }, req);
    } catch (e) {
      server.json(res, 500, { error: e instanceof Error ? e.message : String(e) }, req);
    }
  });

  // POST /api/office-env/{up|pause|resume|stop|restart|status}
  const verb = (path: string, run: (flowId: string) => void) => {
    server.post(`/api/office-env/${path}`, async (req, res) => {
      try {
        const body = await server.parseBody<{ flow_id?: string }>(req);
        if (!body.flow_id) return server.json(res, 400, { error: "flow_id required" }, req);
        run(body.flow_id);
        server.json(res, 200, { status: service.status(body.flow_id) }, req);
      } catch (e) {
        server.json(res, 400, { error: e instanceof Error ? e.message : String(e) }, req);
      }
    });
  };
  verb("up", (f) => service.up(f));
  verb("pause", (f) => service.pause(f));
  verb("resume", (f) => service.resume(f));
  verb("stop", (f) => service.stop(f));
  verb("restart", (f) => service.restart(f));
  verb("status", () => { /* status is read in the wrapper; no-op action */ });
}

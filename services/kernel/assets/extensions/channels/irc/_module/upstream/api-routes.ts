/**
 * Dashboard API for the bouncer's networks.
 *
 * The kernel HTTP surface authenticates with a single shared token and carries
 * no user identity, so every route names its IRC account explicitly. Per-user
 * isolation is enforced where identity actually exists — on the IRC connection
 * itself, in UpstreamManager.
 *
 * Passwords go in and never come out: responses carry `hasPassword` instead.
 */
import type { IncomingMessage } from "node:http";
import type { KernelHttpServer } from "../../../../../../src/core/http-server.js";
import type { UpstreamManager } from "./manager.js";
import type { UpstreamStore } from "./store.js";
import { NETWORK_PRESETS, findPreset } from "./networks.js";
import { isNetworkSlug, toNetworkSlug } from "./naming.js";

interface Body {
  account?: string;
  network?: string;
  label?: string;
  host?: string;
  port?: number;
  tls?: boolean;
  nick?: string;
  username?: string;
  realname?: string;
  sasl_account?: string;
  password?: string;
  enabled?: boolean;
}

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64_000) raw = raw.slice(0, 64_000);
    });
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function paramId(req: IncomingMessage): string {
  return (req as IncomingMessage & { params?: Record<string, string> }).params?.id ?? "";
}

export function registerUpstreamRoutes(
  server: KernelHttpServer,
  manager: UpstreamManager,
  store: UpstreamStore,
): void {
  // List the account's networks, their live state, and the presets the UI
  // offers when adding one.
  server.get("/api/irc/upstreams", (req, res) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const account = url.searchParams.get("account") ?? "";
      if (!account) {
        server.json(res, 400, { error: "account is required" });
        return;
      }
      server.json(res, 200, { upstreams: manager.status(account), presets: NETWORK_PRESETS });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/irc/upstreams", async (req, res) => {
    try {
      const body = await readBody(req);
      const account = (body.account ?? "").trim();
      const nick = (body.nick ?? "").trim();
      if (!account || !nick) {
        server.json(res, 400, { error: "account and nick are required" });
        return;
      }
      // A preset fills in the connection details; a custom host overrides them.
      const network = toNetworkSlug(body.network ?? "");
      if (!isNetworkSlug(network)) {
        server.json(res, 400, { error: "network must be a slug like 'dalnet'" });
        return;
      }
      const preset = findPreset(network);
      const host = (body.host ?? preset?.host ?? "").trim();
      if (!host) {
        server.json(res, 400, { error: "host is required for a network with no preset" });
        return;
      }
      if (store.find(account, network)) {
        server.json(res, 409, { error: `${network} is already configured for this account` });
        return;
      }
      const row = store.create({
        account,
        network,
        label: body.label ?? preset?.name ?? network,
        host,
        port: body.port ?? preset?.port ?? 6697,
        tls: body.tls ?? preset?.tls ?? true,
        nick,
        username: body.username ?? nick,
        realname: body.realname ?? nick,
        sasl_account: body.sasl_account ?? "",
        password: body.password ?? "",
        enabled: body.enabled ?? true,
      });
      if (row.enabled === 1) manager.connect(row.id);
      server.json(res, 201, { upstreams: manager.status(account) });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // PUT rather than PATCH because the kernel HTTP server exposes no patch verb;
  // the semantics are still partial-update (undefined fields keep their value).
  server.put("/api/irc/upstreams/:id", async (req, res) => {
    try {
      const id = paramId(req);
      const row = store.get(id);
      if (!row) {
        server.json(res, 404, { error: "Not found" });
        return;
      }
      const body = await readBody(req);
      store.update(id, {
        label: body.label,
        host: body.host,
        port: body.port,
        tls: body.tls,
        nick: body.nick,
        username: body.username,
        realname: body.realname,
        sasl_account: body.sasl_account,
        // Undefined keeps the stored password; "" clears it.
        password: body.password,
        enabled: body.enabled,
      });
      manager.reload(id);
      server.json(res, 200, { upstreams: manager.status(row.account) });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.delete("/api/irc/upstreams/:id", (req, res) => {
    try {
      const id = paramId(req);
      const row = store.get(id);
      if (!row) {
        server.json(res, 404, { error: "Not found" });
        return;
      }
      manager.disconnect(id);
      store.remove(id);
      server.json(res, 200, { upstreams: manager.status(row.account) });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/irc/upstreams/:id/connect", (req, res) => {
    try {
      const id = paramId(req);
      const row = store.get(id);
      if (!row) {
        server.json(res, 404, { error: "Not found" });
        return;
      }
      store.setEnabled(id, true);
      // Reconnecting clears whatever stopped it last time (bad password, K-line).
      store.setError(id, "");
      manager.connect(id);
      server.json(res, 200, { upstreams: manager.status(row.account) });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/irc/upstreams/:id/disconnect", (req, res) => {
    try {
      const id = paramId(req);
      const row = store.get(id);
      if (!row) {
        server.json(res, 404, { error: "Not found" });
        return;
      }
      store.setEnabled(id, false);
      manager.disconnect(id);
      server.json(res, 200, { upstreams: manager.status(row.account) });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
}

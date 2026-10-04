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
import { HttpError, type KernelHttpServer } from "@kernl/extension-sdk";
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

export function registerUpstreamRoutes(
  server: KernelHttpServer,
  manager: UpstreamManager,
  store: UpstreamStore,
): void {
  const requireRow = (id: string) => {
    const row = store.get(id);
    if (!row) throw new HttpError(404, "Not found");
    return row;
  };

  // List the account's networks, their live state, and the presets the UI
  // offers when adding one.
  server.route("GET", "/api/irc/upstreams", ({ query }) => {
    const account = query.get("account") ?? "";
    if (!account) throw new HttpError(400, "account is required");
    return { upstreams: manager.status(account), presets: NETWORK_PRESETS };
  });

  // Stays a raw handler, like the PUT below: readBody() is deliberately lenient
  // (64 KB cap, malformed JSON reads as {}), which route() would turn into 400/413.
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
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id ?? "";
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

  server.route("DELETE", "/api/irc/upstreams/:id", ({ params: { id } }) => {
    const row = requireRow(id);
    manager.disconnect(id);
    store.remove(id);
    return { upstreams: manager.status(row.account) };
  });

  server.route("POST", "/api/irc/upstreams/:id/connect", ({ params: { id } }) => {
    const row = requireRow(id);
    store.setEnabled(id, true);
    // Reconnecting clears whatever stopped it last time (bad password, K-line).
    store.setError(id, "");
    manager.connect(id);
    return { upstreams: manager.status(row.account) };
  });

  server.route("POST", "/api/irc/upstreams/:id/disconnect", ({ params: { id } }) => {
    const row = requireRow(id);
    store.setEnabled(id, false);
    manager.disconnect(id);
    return { upstreams: manager.status(row.account) };
  });
}

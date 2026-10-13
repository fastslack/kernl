/**
 * Claude login relay — catches the subscription sign-in's redirect on the host.
 *
 * In Docker, `claude auth login` listens on localhost INSIDE the container, on
 * a port it picks at random, and Claude's approval page sends the browser to
 * that port on the HOST's localhost, where nothing listens. The dashboard
 * covers it by asking for the dead address back as a paste.
 *
 * This relay runs with `network_mode: host` (docker-compose.host.yml) and
 * removes the paste: the kernel leaves the CLI's approval link in a dir on the
 * shared data volume while a sign-in waits (KERNL_CLAUDE_LOGIN_DIR); the relay
 * reads the port off it, listens there on the host's loopback, and hands the
 * redirect to the kernel's own paste endpoint — the same path, with the same
 * state check, as a paste. The kernel removes the dir when the sign-in ends,
 * and the relay stops listening.
 *
 * Linux only: on Docker Desktop the host network is not the user's machine.
 * Without the relay, or when the port is taken on the host, the paste still works.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LOGIN_DIR = process.env.KERNL_CLAUDE_LOGIN_DIR ?? "/kernl-data/claude-login";
const TOKEN_FILE = process.env.KERNL_TOKEN_FILE ?? "/kernl-data/.kernel-auth-token";
const API = process.env.KERNL_API ?? "http://127.0.0.1:3086";
const POLL_MS = 1000;

/** The port of the sign-in waiting now, read off the link the CLI produced. */
export function pendingPort(loginDir: string): number | null {
  let entries: string[];
  try { entries = readdirSync(loginDir); } catch { return null; }
  for (const entry of entries) {
    try {
      const url = new URL(readFileSync(join(loginDir, entry, "authorize-url"), "utf-8").trim());
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      const port = Number(redirect.port);
      if (redirect.hostname === "localhost" && port > 0) return port;
    } catch { /* not written yet, or not a sign-in dir */ }
  }
  return null;
}

export interface RelayDeps {
  api: string;
  token: () => string;
  fetchImpl?: typeof fetch;
}

/** Hand the browser's redirect to the kernel and tell the user how it went. */
export async function relayCallback(req: Request, deps: RelayDeps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "GET" || url.pathname !== "/callback") return new Response("Not found", { status: 404 });
  let ok = false;
  let error = "unreachable";
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${deps.api}/api/llm/claude-code/login/callback`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.token()}` },
      body: JSON.stringify({ url: req.url }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as { delivered?: boolean; deliverError?: string; error?: string };
    ok = res.ok && body.delivered === true;
    error = body.deliverError ?? body.error ?? `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return new Response(page(ok, error), {
    status: ok ? 200 : 502,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function page(ok: boolean, error: string): string {
  const title = ok ? "Claude conectado · Claude connected" : "No se pudo conectar · Could not connect";
  const body = ok
    ? "<p>Kernl ya tiene tu sesión. Podés cerrar esta pestaña.</p><p>Kernl has your session. You can close this tab.</p>"
    : `<p>Volvé a Kernl y pegá esta dirección en el campo de Configuración → IA.</p>`
      + `<p>Go back to Kernl and paste this address into Settings → AI.</p><pre>${escapeHtml(error)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>`
    + `<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;max-width:560px;margin:15vh auto;padding:0 16px}`
    + `pre{color:#f90;white-space:pre-wrap}</style></head><body><h1>${ok ? "✓ " : ""}${title}</h1>${body}`
    + (ok ? "<script>setTimeout(()=>window.close(),1500)</script>" : "")
    + `</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// ── main ──────────────────────────────────────────────────────────────────────

type Server = ReturnType<typeof Bun.serve>;

function main(): void {
  const deps: RelayDeps = { api: API, token: () => readFileSync(TOKEN_FILE, "utf-8").trim() };
  let port: number | null = null;
  let servers: Server[] = [];

  const listen = (p: number) => {
    // "localhost" is two addresses, and the browser may pick either.
    for (const hostname of ["127.0.0.1", "::1"]) {
      try {
        servers.push(Bun.serve({ hostname, port: p, fetch: (req) => relayCallback(req, deps) }));
      } catch (err) {
        console.warn(`[claude-login-relay] cannot listen on ${hostname}:${p} — the paste still works:`, (err as Error).message);
      }
    }
    if (servers.length) console.log(`[claude-login-relay] sign-in waiting: listening on localhost:${p}`);
  };

  setInterval(() => {
    const next = pendingPort(LOGIN_DIR);
    if (next === port) return;
    for (const s of servers) s.stop(true);
    if (servers.length) console.log(`[claude-login-relay] sign-in over: closed localhost:${port}`);
    servers = [];
    port = next;
    if (next) listen(next);
  }, POLL_MS);
  console.log(`[claude-login-relay] watching ${LOGIN_DIR}`);
}

if (import.meta.main) main();

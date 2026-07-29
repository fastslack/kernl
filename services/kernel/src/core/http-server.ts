import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, watch, existsSync, type FSWatcher } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { log } from "./logger.js";
import type { KernelConfig } from "./config.js";
import { resolveSecureBind } from "./config.js";
import { isAuthenticated, AUTH_EXEMPT_PATHS } from "./auth.js";

const gzipAsync = promisify(gzip);
const GZIP_THRESHOLD = 1024; // Only compress responses > 1KB

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf":  "font/ttf",
  ".map":  "application/json",
};

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

type ParamRouteEntry = { pattern: RegExp; keys: string[]; handler: RouteHandler };

export class KernelHttpServer {
  private server: Server | null = null;
  private routes = new Map<string, RouteHandler>();
  private paramRoutes: ParamRouteEntry[] = [];
  private port: number;
  private bindHost: string;
  private staticDir: string;
  private watcher: FSWatcher | null = null;
  private onStaticChange: (() => void) | null = null;
  private htmlCache: string | null = null;
  private authToken: string;
  private corsOrigins: string[];

  // Simple IP rate limiter for HTTP API (separate from messaging rate limiter)
  private apiRateLimits = new Map<string, { count: number; resetAt: number }>();
  private static API_RATE_LIMIT = 1000; // requests per minute
  private static API_RATE_WINDOW = 60_000; // 1 minute
  private rateLimitCleanup: ReturnType<typeof setInterval> | null = null;

  get nodeServer(): Server | null { return this.server; }

  constructor(opts: { config: KernelConfig }) {
    this.port = opts.config.dashboard.port;
    this.authToken = opts.config.auth.token;
    // Defense in depth for H7: re-apply the fail-closed rule at the actual
    // bind site so the invariant (never expose an unauthenticated surface off
    // loopback) holds even if this config was built without loadConfig().
    // Idempotent — loadConfig already downgraded it when no token is set.
    // Defense-in-depth re-check of the bind. Must pass the same explicit
    // operator switches as loadConfig() or this second pass silently
    // downgrades the container escape hatch (ALLOW_UNAUTH + explicit bind)
    // back to loopback and every nginx-proxied request 502s.
    this.bindHost = resolveSecureBind(opts.config.dashboard.bind, this.authToken, {
      allowUnauth: process.env.KERNEL_ALLOW_UNAUTH === "1",
      bindIsExplicit: process.env.KERNEL_DASHBOARD_BIND !== undefined,
    });
    this.corsOrigins = opts.config.cors.allowedOrigins;

    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Try SvelteKit build: env override first, then known locations
    // (native dev pre/post services/ layout, bundled dist/, Docker cwd).
    const candidates = [
      ...(process.env.DASHBOARD_STATIC_DIR ? [resolve(process.env.DASHBOARD_STATIC_DIR)] : []),
      resolve(__dirname, "../../services/dashboard/build"),  // dev: src/core at the repo root
      resolve(__dirname, "../../../dashboard/build"),        // dev: services/kernel/src/core (layout final)
      resolve(__dirname, "../dashboard/build"),              // bundled: dist/ → ../dashboard/build (Docker)
      resolve(process.cwd(), "dashboard/build"),             // cwd-relative (Docker /app)
    ];
    this.staticDir = candidates.find(p => existsSync(p)) || candidates[0];
    log.info(`Dashboard static dir: ${this.staticDir}`);

    this.rateLimitCleanup = setInterval(() => this.apiRateLimits.clear(), 60_000);
    this.rateLimitCleanup.unref();
  }

  private checkApiRateLimit(req: IncomingMessage): boolean {
    const ip = req.socket.remoteAddress ?? "unknown";
    // Skip rate limiting for local/private network requests (localhost, Docker, LAN)
    const raw = ip.replace("::ffff:", "");
    if (raw === "127.0.0.1" || ip === "::1" || raw.startsWith("192.168.") || raw.startsWith("10.") || raw.startsWith("172.")) return true;
    const now = Date.now();
    let entry = this.apiRateLimits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + KernelHttpServer.API_RATE_WINDOW };
      this.apiRateLimits.set(ip, entry);
    }
    entry.count++;
    return entry.count <= KernelHttpServer.API_RATE_LIMIT;
  }

  private registerRoute(method: string, path: string, handler: RouteHandler): void {
    // A trailing `/*` captures the remainder of the path (may contain slashes)
    // into params.rest — e.g. "/ext-assets/:slug/*" matches
    // "/ext-assets/books/a/b.js" with { slug: "books", rest: "a/b.js" }.
    const hasWildcard = path.endsWith("/*");
    if (path.includes(":") || hasWildcard) {
      // Convert :param segments to named capture groups
      const keys: string[] = [];
      const base = hasWildcard ? path.slice(0, -2) : path;
      let regexStr = base.replace(/:([^/]+)/g, (_m, key) => { keys.push(key); return "([^/]+)"; });
      if (hasWildcard) { keys.push("rest"); regexStr += "/(.+)"; }
      const pattern = new RegExp(`^${method}:${regexStr}$`);
      this.paramRoutes.push({ pattern, keys, handler });
    } else {
      this.routes.set(`${method}:${path}`, handler);
    }
  }

  get(path: string, handler: RouteHandler): void {
    this.registerRoute("GET", path, handler);
    // HEAD mirrors GET (RFC 9110 §9.3.2). Node's ServerResponse discards the
    // body for HEAD requests, so the same handler serves both — without this,
    // `curl -I` on any GET route fell through to the SPA fallback.
    this.registerRoute("HEAD", path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.registerRoute("POST", path, handler);
  }

  put(path: string, handler: RouteHandler): void {
    this.registerRoute("PUT", path, handler);
  }

  delete(path: string, handler: RouteHandler): void {
    this.registerRoute("DELETE", path, handler);
  }

  /** Register a handler for all HTTP methods (GET, POST, PUT, DELETE). */
  all(path: string, handler: RouteHandler): void {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      this.registerRoute(method, path, handler);
    }
  }

  /** Compute the Access-Control-Allow-Origin value for a request. */
  private getAllowedOrigin(req?: IncomingMessage): string {
    if (this.corsOrigins.length === 0) return "*";
    const origin = req?.headers.origin ?? "";
    if (this.corsOrigins.includes(origin)) return origin;
    // If no match, return the first configured origin (browser will block the request)
    return this.corsOrigins[0];
  }

  parseBody<T = unknown>(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<T> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      req.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > maxBytes) {
          req.destroy();
          reject(new Error(`Request body exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T);
        } catch {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  json(res: ServerResponse, status: number, data: unknown, req?: IncomingMessage): void {
    const body = JSON.stringify(data);
    const origin = this.getAllowedOrigin(req);
    // Gzip if client accepts it and response is large enough
    if (req && body.length > GZIP_THRESHOLD && req.headers["accept-encoding"]?.includes("gzip")) {
      gzipAsync(Buffer.from(body)).then((compressed) => {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Encoding": "gzip",
          "Access-Control-Allow-Origin": origin,
          "Cache-Control": "no-store",
          ...SECURITY_HEADERS,
        });
        res.end(compressed);
      }).catch(() => {
        // Fallback to uncompressed on gzip error
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": origin,
          "Cache-Control": "no-store",
          ...SECURITY_HEADERS,
        });
        res.end(body);
      });
      return;
    }
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    });
    res.end(body);
  }

  async start(): Promise<boolean> {
    return new Promise((ok) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          log.warn(`Dashboard port ${this.port} already in use — skipping (another instance is serving the dashboard)`);
          this.server = null;
          ok(false);
        } else {
          throw err;
        }
      });
      this.server.listen(this.port, this.bindHost, () => {
        log.info(`Dashboard HTTP server listening on http://${this.bindHost}:${this.port}`);
        if (!this.authToken) {
          // H7 fail-closed: with no token the bind was forced to loopback, so
          // the (unauthenticated) tool surface is not remotely reachable.
          log.warn(
            `SECURITY: KERNEL_AUTH_TOKEN is empty — authentication is DISABLED and the server is bound to ${this.bindHost} (localhost only). `
              + "Set KERNEL_AUTH_TOKEN to enable auth; only then is KERNEL_DASHBOARD_BIND honored for LAN/remote access.",
          );
        } else if (this.bindHost === "0.0.0.0") {
          log.warn(
            "SECURITY: dashboard bound to 0.0.0.0 — anyone on the LAN with KERNEL_AUTH_TOKEN can hit /api/*. "
              + "Set KERNEL_DASHBOARD_BIND=127.0.0.1 to restrict to localhost.",
          );
        }
        ok(true);
      });
    });
  }

  /** Register a callback for static file changes (for hot reload). */
  watchStatic(onChange: () => void): void {
    this.onStaticChange = onChange;
    try {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      this.watcher = watch(this.staticDir, { recursive: true }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          log.info("Static file changed — notifying clients");
          this.htmlCache = null; // invalidate SPA cache on static file change
          this.onStaticChange?.();
        }, 300);
      });
      this.watcher.unref();
      log.info("Static file watcher active (hot reload enabled)");
    } catch (err) {
      log.warn("Could not watch static dir for hot reload", err);
    }
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    if (this.rateLimitCleanup) clearInterval(this.rateLimitCleanup);
    return new Promise((ok) => {
      if (!this.server) return ok();
      this.server.close(() => {
        log.info("Dashboard HTTP server stopped");
        ok();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = this.getAllowedOrigin(req);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, mcp-protocol-version",
        ...SECURITY_HEADERS,
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const pathname = url.pathname;

    // ── API rate limiting ──
    if (pathname.startsWith("/api/") && !this.checkApiRateLimit(req)) {
      res.writeHead(429, { "Content-Type": "application/json", ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: "Too many requests. Try again later." }));
      return;
    }

    // ── Auth verification endpoint (built-in, before route matching) ──
    if (pathname === "/api/auth/verify") {
      if (!this.authToken) {
        this.json(res, 200, { valid: true, authEnabled: false }, req);
      } else {
        const valid = isAuthenticated(req, this.authToken);
        this.json(res, 200, { valid, authEnabled: true }, req);
      }
      return;
    }

    // ── Authentication gate ──
    // Exempt paths (/api/health, /api/auth/verify) and non-API paths skip auth.
    // /mcp has its own auth mechanism.
    if (this.authToken && pathname.startsWith("/api/") && !AUTH_EXEMPT_PATHS.includes(pathname)) {
      if (!isAuthenticated(req, this.authToken)) {
        this.json(res, 401, { error: "Unauthorized" }, req);
        return;
      }
    }

    const key = `${req.method}:${pathname}`;

    let handler = this.routes.get(key);
    if (handler) {
      try {
        await handler(req, res);
      } catch (err) {
        log.error(`HTTP handler error: ${key}`, err);
        this.json(res, 500, { error: "Internal server error" }, req);
      }
      return;
    }

    // Try parameterized routes
    for (const entry of this.paramRoutes) {
      const m = key.match(entry.pattern);
      if (m) {
        const params: Record<string, string> = {};
        entry.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        (req as unknown as { params: Record<string, string> }).params = params;
        try {
          await entry.handler(req, res);
        } catch (err) {
          log.error(`HTTP handler error: ${key}`, err);
          this.json(res, 500, { error: "Internal server error" }, req);
        }
        return;
      }
    }

    // Standalone upload page
    if (url.pathname === "/upload") {
      const here = dirname(fileURLToPath(import.meta.url));
      // Source layout (src/core/ → src/modules/dashboard/static/) vs bundled
      // layout (dist/ → dist/static/, where `npm run build` copies the dir).
      const candidates = [
        resolve(here, "../modules/dashboard/static/upload.html"),
        resolve(here, "static/upload.html"),
      ];
      const uploadPath = candidates.find((p) => existsSync(p)) ?? candidates[0];
      try {
        const html = readFileSync(uploadPath, "utf-8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          ...SECURITY_HEADERS,
        });
        res.end(html);
      } catch {
        this.json(res, 500, { error: "Upload page not found" });
      }
      return;
    }

    // Static assets (_app/, favicon, etc.) — serve with correct MIME type and long cache
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/mcp")) {
      const assetPath = resolve(this.staticDir, url.pathname.replace(/^\//, ""));
      const ext = extname(assetPath);
      if (ext && ext !== ".html" && existsSync(assetPath)) {
        try {
          const data = readFileSync(assetPath);
          const mime = MIME[ext] ?? "application/octet-stream";
          const isImmutable = url.pathname.startsWith("/_app/immutable/");
          res.writeHead(200, {
            "Content-Type": mime,
            "Cache-Control": isImmutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
            ...SECURITY_HEADERS,
          });
          res.end(data);
        } catch {
          this.json(res, 404, { error: "Asset not found" });
        }
        return;
      }

      // SPA fallback — serve index.html for all non-API, non-asset routes (always read from disk)
      try {
        const indexPath = resolve(this.staticDir, "index.html");
        const html = readFileSync(indexPath, "utf-8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          "Pragma": "no-cache",
          "Expires": "0",
          ...SECURITY_HEADERS,
        });
        res.end(html);
      } catch {
        this.json(res, 500, { error: "Dashboard HTML not found" });
      }
      return;
    }

    this.json(res, 404, { error: "Not found" });
  }
}

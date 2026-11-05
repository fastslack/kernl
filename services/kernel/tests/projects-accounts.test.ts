/**
 * A project's own Cloudflare, Datadog, AWS and git identity: tested before it
 * is saved, sealed at rest, shown masked, and handed to a deploy only for its
 * own project.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/sdk/migrations.js";
import { generateKey } from "../src/sdk/crypto.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectAccountsService, projectOfRepo, signedCallerIdentity } from "../src/modules/projects/accounts.js";

const key = generateKey();
const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";
let db: InstanceType<typeof Database>;
let calls: Array<{ url: string; init: RequestInit }>;

/** A fake of the four services: each answers ok unless the credential is "bad". */
const services = (async (url: string, init: RequestInit) => {
  calls.push({ url, init });
  const h = (init.headers ?? {}) as Record<string, string>;
  if (url.startsWith("https://api.cloudflare.com/")) {
    return h.Authorization === "Bearer bad"
      ? Response.json({ success: false, errors: [{ message: "Invalid API Token" }] }, { status: 403 })
      : Response.json({ success: true, result: { name: "Matware" } });
  }
  if (url.includes("datadoghq")) return h["DD-API-KEY"] === "bad" ? Response.json({ errors: ["Forbidden"] }, { status: 403 }) : Response.json({ valid: true });
  if (url.includes("amazonaws.com")) {
    return h.Authorization.includes("AKIABADBADBADBADBADB")
      ? new Response("<ErrorResponse><Error><Message>The security token included in the request is invalid.</Message></Error></ErrorResponse>", { status: 403 })
      : new Response("<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/matware-deploy</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>");
  }
  return new Response("unexpected", { status: 500 });
}) as unknown as typeof fetch;

function project(id: string) {
  db.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 'x', 'x')").run(id, id, id);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, "projects", projectsMigrations);
  project("matware");
  project("acme");
  calls = [];
});
afterEach(() => db.close());

describe("project accounts", () => {
  it("finds the Cloudflare account from the token when no Account ID is given", async () => {
    const one = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const tok = ((init.headers ?? {}) as Record<string, string>).Authorization;
      if (url.endsWith("/accounts?per_page=50")) {
        return Response.json({ success: true, result: tok === "Bearer two-accounts"
          ? [{ id: CF_ACCOUNT, name: "Matware" }, { id: "f".repeat(32), name: "Otra" }] : [{ id: CF_ACCOUNT, name: "Matware" }] });
      }
      return Response.json({ success: true, result: { name: "Matware" } });
    }) as unknown as typeof fetch;
    const svc = new ProjectAccountsService(db, key, one);
    const cf = await svc.set("matware", "cloudflare", { api_token: "account-owned" });
    expect(cf.identity).toBe("cuenta Matware");
    expect(svc.get("matware", "cloudflare")!.config.account_id).toBe(CF_ACCOUNT);
    await expect(svc.set("acme", "cloudflare", { api_token: "two-accounts" })).rejects.toThrow("pegá el Account ID");
    expect(svc.get("acme", "cloudflare")).toBeNull();
    await expect(svc.set("acme", "cloudflare", { account_id: "nope", api_token: "x" })).rejects.toThrow("32 caracteres");
  });

  it("tests an account before saving it and says who it is", async () => {
    const svc = new ProjectAccountsService(db, key, services);
    const a = await svc.set("matware", "aws", { region: "eu-west-1", access_key_id: "AKIAABCDEFGHIJKLMNOP", secret_access_key: "s3cr3t-value-xyz" });
    expect(a.identity).toBe("arn:aws:iam::123456789012:user/matware-deploy");
    expect(a.secrets).toEqual({ secret_access_key: "…-xyz" });
    expect(calls[0].url).toBe("https://sts.eu-west-1.amazonaws.com/");
    const cf = await svc.set("matware", "cloudflare", { account_id: CF_ACCOUNT, api_token: "good-token-1234" });
    expect(cf.identity).toBe("cuenta Matware");
    expect(calls[1].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}`);
  });

  it("a refused account is not saved, and the stored one stays", async () => {
    const svc = new ProjectAccountsService(db, key, services);
    await expect(svc.set("matware", "cloudflare", { account_id: CF_ACCOUNT, api_token: "bad" })).rejects.toThrow("Invalid API Token");
    expect(svc.list("matware")).toEqual([]);
    await svc.set("matware", "datadog", { site: "https://app.datadoghq.eu/rum", api_key: "good-key-1234" });
    await expect(svc.set("matware", "datadog", { site: "datadoghq.eu", api_key: "bad" })).rejects.toThrow("Datadog rechazó");
    expect(svc.get("matware", "datadog")!.secrets.api_key).toBe("good-key-1234");
    expect(svc.get("matware", "datadog")!.config.site).toBe("datadoghq.eu");
  });

  it("checks the fields before calling anyone", async () => {
    const svc = new ProjectAccountsService(db, key, services);
    await expect(svc.set("matware", "aws", { region: "eu-west-1", access_key_id: "nope", secret_access_key: "x" })).rejects.toThrow("AKIA");
    await expect(svc.set("matware", "datadog", { site: "evil.example", api_key: "k" })).rejects.toThrow("no es una región de Datadog");
    await expect(svc.set("matware", "git", { name: "Matware", email: "bad" })).rejects.toThrow("no es un email");
    await expect(svc.set("matware", "git", { name: "M", email: "dev@matware.nl", ssh_private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nx\n-----END OPENSSH PRIVATE KEY-----" })).rejects.toThrow("passphrase");
    await expect(svc.set("matware", "cloudflare", { account_id: CF_ACCOUNT })).rejects.toThrow("api_token es obligatorio");
    expect(calls).toEqual([]);
  });

  it("seals the secrets at rest; an edit with the secret left blank keeps it", async () => {
    const svc = new ProjectAccountsService(db, key, services);
    await svc.set("matware", "cloudflare", { account_id: CF_ACCOUNT, api_token: "good-token-1234" });
    const raw = (db.prepare("SELECT secrets FROM project_accounts").get() as { secrets: string }).secrets;
    expect(raw).not.toContain("good-token");
    await svc.set("matware", "cloudflare", { account_id: CF_ACCOUNT, api_token: "" });
    expect(svc.get("matware", "cloudflare")!.secrets.api_token).toBe("good-token-1234");
  });

  it("a deploy gets its own project's environment and nothing from another", async () => {
    const svc = new ProjectAccountsService(db, key, services);
    await svc.set("matware", "cloudflare", { account_id: CF_ACCOUNT, api_token: "matware-cf-token" });
    await svc.set("matware", "git", { name: "Matware Deploy", email: "deploy@matware.nl" });
    await svc.set("acme", "aws", { region: "us-east-1", access_key_id: "AKIAACMEACMEACMEACME", secret_access_key: "acme-secret" });
    expect(svc.env("matware")).toEqual({
      CLOUDFLARE_API_TOKEN: "matware-cf-token", CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT,
      GIT_AUTHOR_NAME: "Matware Deploy", GIT_AUTHOR_EMAIL: "deploy@matware.nl",
      GIT_COMMITTER_NAME: "Matware Deploy", GIT_COMMITTER_EMAIL: "deploy@matware.nl",
    });
    expect(Object.keys(svc.env("acme")).sort()).toEqual(["AWS_ACCESS_KEY_ID", "AWS_DEFAULT_REGION", "AWS_REGION", "AWS_SECRET_ACCESS_KEY"]);
  });

  it("goes with its project", async () => {
    const svc = new ProjectAccountsService(db, key, services);
    await svc.set("matware", "git", { name: "M", email: "m@matware.nl" });
    db.exec("PRAGMA foreign_keys = ON; DELETE FROM projects WHERE id = 'matware'");
    expect(db.prepare("SELECT COUNT(*) n FROM project_accounts").get()).toEqual({ n: 0 });
  });
});

describe("signedCallerIdentity", () => {
  it("signs a SigV4 STS call for the region", () => {
    const { url, init } = signedCallerIdentity("AKIAABCDEFGHIJKLMNOP", "secret", "eu-west-1", new Date("2026-11-03T05:00:00.000Z"));
    const h = init.headers as Record<string, string>;
    expect(url).toBe("https://sts.eu-west-1.amazonaws.com/");
    expect(h["X-Amz-Date"]).toBe("20261103T050000Z");
    expect(h.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAABCDEFGHIJKLMNOP\/20261103\/eu-west-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(init.body).toBe("Action=GetCallerIdentity&Version=2011-06-15");
  });
});

describe("projectOfRepo", () => {
  beforeEach(() => {
    db.exec("CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL DEFAULT '', remote_url TEXT NOT NULL DEFAULT '', deleted_at TEXT)");
    db.exec(`INSERT INTO repos VALUES ('r1', '/home/u/Matware/web', 'git@github.com:fastslack/web.git', NULL);
      INSERT INTO project_links (id, project_id, kind, ref_id, created_at) VALUES ('l1', 'matware', 'repo', 'r1', 'x')`);
  });
  it("finds the project by path or by any spelling of the remote", () => {
    expect(projectOfRepo(db, "/home/u/Matware/web/")).toBe("matware");
    expect(projectOfRepo(db, "https://github.com/FastSlack/web")).toBe("matware");
    expect(projectOfRepo(db, "git@github.com:fastslack/other.git")).toBeUndefined();
  });
  it("no single owner, no project", () => {
    db.exec("INSERT INTO project_links (id, project_id, kind, ref_id, created_at) VALUES ('l2', 'acme', 'repo', 'r1', 'x')");
    expect(projectOfRepo(db, "/home/u/Matware/web")).toBeUndefined();
  });
});

describe("the project's own deploy environment", () => {
  it("takes any variable and an optional image, sealed, last in the deploy env", async () => {
    const svc = new ProjectAccountsService(db, key, services);
    await svc.set("matware", "cloudflare", { account_id: CF_ACCOUNT, api_token: "card-token" });
    const a = await svc.set("matware", "env", { image: "ghcr.io/acme/deploy:1", variables: [{ name: "VERCEL_TOKEN", value: "vercel-secret-1" }, { name: "CLOUDFLARE_API_TOKEN", value: "override-token" }] });
    expect(a.identity).toBe("2 variables, imagen ghcr.io/acme/deploy:1");
    expect(a.secrets).toEqual({ VERCEL_TOKEN: "…et-1", CLOUDFLARE_API_TOKEN: "…oken" });
    expect(calls).toHaveLength(1); // only the Cloudflare card went out
    expect(svc.env("matware")).toMatchObject({ VERCEL_TOKEN: "vercel-secret-1", CLOUDFLARE_API_TOKEN: "override-token", CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT });
    expect(svc.get("matware", "env")!.config.image).toBe("ghcr.io/acme/deploy:1");
  });

  it("an edit keeps a value left blank and drops a variable left out", async () => {
    const svc = new ProjectAccountsService(db, key, services);
    await svc.set("matware", "env", { variables: { FLY_API_TOKEN: "fly-1", NETLIFY_AUTH_TOKEN: "nf-1" } });
    await svc.set("matware", "env", { variables: [{ name: "FLY_API_TOKEN", value: "" }] });
    expect(svc.get("matware", "env")!.secrets).toEqual({ FLY_API_TOKEN: "fly-1" });
  });

  it("refuses names the deploy uses, bad names, multi-line values and bad images", async () => {
    const svc = new ProjectAccountsService(db, key, services);
    await expect(svc.set("matware", "env", { variables: { DEPLOY_COMMAND_B64: "x" } })).rejects.toThrow("lo usa el deploy");
    await expect(svc.set("matware", "env", { variables: { PATH: "/x" } })).rejects.toThrow("lo usa el deploy");
    await expect(svc.set("matware", "env", { variables: { "my-token": "x" } })).rejects.toThrow("mayúsculas");
    await expect(svc.set("matware", "env", { variables: { A: "x\ny" } })).rejects.toThrow("una sola línea");
    await expect(svc.set("matware", "env", { image: "--privileged" })).rejects.toThrow("no es una imagen");
    await expect(svc.set("matware", "env", {})).rejects.toThrow("al menos una variable");
  });
});


describe("Datadog connect", () => {
  /** Datadog as it is: a key answers only on the region it was made in; the app key may lack the RUM scope. */
  const datadog = (home: string) => (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const h = (init.headers ?? {}) as Record<string, string>;
    if (!url.startsWith(`https://api.${home}/`)) return Response.json({ errors: ["Forbidden"] }, { status: 403 });
    if (url.endsWith("/api/v1/validate")) return Response.json({ valid: true });
    if (h["DD-APPLICATION-KEY"] === "no-rum") return Response.json({ errors: ["Forbidden"] }, { status: 403 });
    if (h["DD-APPLICATION-KEY"] === "wrong") return Response.json({ errors: ["Unauthorized"] }, { status: 401 });
    return Response.json({ data: [] });
  }) as unknown as typeof fetch;

  it("finds the region from the key when the wrong one was picked", async () => {
    const svc = new ProjectAccountsService(db, key, datadog("us5.datadoghq.com"));
    const a = await svc.set("matware", "datadog", { site: "datadoghq.com", api_key: "k-1234567890" });
    expect(a.config.site).toBe("us5.datadoghq.com");
    expect(a.identity).toBe("API key válida en us5.datadoghq.com (región detectada)");
  });

  it("checks the application key can read RUM, and says which scope is missing", async () => {
    const svc = new ProjectAccountsService(db, key, datadog("datadoghq.eu"));
    const a = await svc.set("matware", "datadog", { site: "datadoghq.eu", api_key: "k-1234567890", app_key: "ok-app-key" });
    expect(a.identity).toBe("API key válida en datadoghq.eu · lee RUM");
    await expect(svc.set("matware", "datadog", { site: "datadoghq.eu", api_key: "k-1234567890", app_key: "no-rum" })).rejects.toThrow("rum_apps_read");
    await expect(svc.set("matware", "datadog", { site: "datadoghq.eu", api_key: "k-1234567890", app_key: "wrong" })).rejects.toThrow("rechazó la application key");
  });
});

describe("Google linked by consent", () => {
  const G = { clientId: "cid", clientSecret: "csec", redirectUri: "http://localhost:3087/auth/google/callback" };
  const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;
  /** Google as it is: token endpoint, GA4 metadata (property 111 only), Search Console sites (example.com only). */
  const google = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      const b = new URLSearchParams(String(init.body));
      if (b.get("grant_type") === "authorization_code") return Response.json({ access_token: "at", refresh_token: "rt-1", id_token: idToken("ops@example.com"), expires_in: 3600 });
      return Response.json({ access_token: `at-${b.get("refresh_token")}`, expires_in: 3600 });
    }
    if (url.includes("/properties/111/metadata")) return Response.json({});
    if (url.includes("analyticsdata")) return Response.json({ error: { message: "denied" } }, { status: 403 });
    if (url === "https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F") return Response.json({ siteUrl: "https://example.com/" });
    if (url.includes("webmasters")) return Response.json({}, { status: 403 });
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;

  it("the consent URL carries the project; the callback state is single-use", async () => {
    const { configureGoogleClient, googleConsentUrl, claimState, isProjectState } = await import("../src/modules/projects/google-link.js");
    configureGoogleClient(() => G);
    const url = new URL(googleConsentUrl("matware", "http://localhost:3086/projects"));
    expect(url.searchParams.get("redirect_uri")).toBe(G.redirectUri);
    expect(url.searchParams.get("scope")).toContain("analytics.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    const state = url.searchParams.get("state")!;
    expect(isProjectState(state)).toBe(true);
    expect(claimState(state)).toBe("matware");
    expect(claimState(state)).toBeNull();
  });

  it("links the account, then saves only what that account can read", async () => {
    const { configureGoogleClient, exchangeCode } = await import("../src/modules/projects/google-link.js");
    configureGoogleClient(() => G);
    const svc = new ProjectAccountsService(db, key, google);
    await expect(svc.set("matware", "google", { ga4_property: "111" })).rejects.toThrow("Conectar con Google");
    const { refreshToken, email } = await exchangeCode("code-1", google);
    expect(email).toBe("ops@example.com");
    expect(svc.linkGoogle("matware", refreshToken, email).identity).toBe("ops@example.com");
    const a = await svc.set("matware", "google", { ga4_property: "properties/111", ga4_name: "Sitio", search_console_sites: ["https://example.com/"] });
    expect(a.identity).toBe("ops@example.com · GA4 Sitio · Search Console: https://example.com/");
    expect(a.secrets).toEqual({ refresh_token: "…" });
    await expect(svc.set("matware", "google", { ga4_property: "222" })).rejects.toThrow("no puede leer la propiedad");
    await expect(svc.set("matware", "google", { search_console_sites: "https://other.example/" })).rejects.toThrow("no tiene acceso");
    expect(svc.get("matware", "google")!.config.ga4_property).toBe("111");
    expect(svc.env("matware")).toEqual({});
  });
});

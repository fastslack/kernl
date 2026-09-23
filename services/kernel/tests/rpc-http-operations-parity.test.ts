/**
 * Marketplace, chat, news, twitter, api-registry and google-sync actions are
 * reached through rpcOrCall: WS RPC when the bridge is up, the HTTP route
 * otherwise. Each pair used to be two implementations that answered
 * differently for the same request; they are one operation now. These tests
 * pin the places they had drifted apart, driven through both roads.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { EventBus } from "../src/core/event-bus.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import type { RpcAction } from "../src/core/mtw/rpc-handler.js";
import { marketplaceMigrations } from "../src/modules/marketplace/migrations.js";
import { MarketplaceService } from "../src/modules/marketplace/service.js";
import { seedDefaultThemes } from "../src/modules/marketplace/seeders.js";
import { marketplaceDashboardRpcActions } from "../src/modules/marketplace/dashboard-rpc-actions.js";
import { registerMarketplaceRoutes } from "../src/modules/marketplace/api-routes.js";
import { chatMigrations } from "../src/modules/chat/migrations/001_chat.js";
import { ChatService } from "../src/modules/chat/service.js";
import { chatDashboardRpcActions } from "../src/modules/chat/dashboard-rpc-actions.js";
import { registerChatRoutes } from "../src/modules/chat/api-routes.js";
import { newsMigrations } from "../assets/extensions/home/news/_module/news-migrations.js";
import { NewsService } from "../assets/extensions/home/news/_module/news-service.js";
import { newsDashboardRpcActions } from "../assets/extensions/home/news/_module/dashboard-rpc-actions.js";
import { registerNewsRoutes } from "../assets/extensions/home/news/_module/routes.js";
import { twitterMigrations } from "../assets/extensions/crm/twitter/_module/migrations.js";
import { TwitterService } from "../assets/extensions/crm/twitter/_module/service.js";
import type { TwitterPublisher } from "../assets/extensions/crm/twitter/_module/publisher.js";
import { twitterDashboardRpcActions } from "../assets/extensions/crm/twitter/_module/dashboard-rpc-actions.js";
import { registerTwitterRoutes } from "../assets/extensions/crm/twitter/_module/api-routes.js";
import { apiRegistryMigrations } from "../assets/extensions/ai/api-registry/_module/migrations/001_api_registry.js";
import { ApiRegistryService } from "../assets/extensions/ai/api-registry/_module/service.js";
import { apiRegistryDashboardRpcActions } from "../assets/extensions/ai/api-registry/_module/dashboard-rpc-actions.js";
import { registerApiRegistryRoutes } from "../assets/extensions/ai/api-registry/_module/api-routes.js";
import { googleSyncMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/001_google_sync.js";
import { googleSyncDashboardRpcActions } from "../assets/extensions/integration/google-sync/_module/dashboard-rpc-actions.js";
import { registerGoogleOAuthRoutes } from "../assets/extensions/integration/google-sync/_module/oauth-routes.js";

const config = JSON.parse(JSON.stringify({
  dashboard: { enabled: false, port: 0, bind: "127.0.0.1", refreshIntervalMs: 30000 },
  auth: { token: "" },
  cors: { allowedOrigins: [] },
  google: { clientId: "", clientSecret: "", callbackPort: 8787 },
  chat: { defaultProvider: "", defaultModel: "", systemPrompt: "", maxEpisodeMessages: 200, contextBudget: 8000 },
  agents: { defaultProvider: "", defaultModel: "", defaultModelChain: [] },
})) as KernelConfig;

let db: InstanceType<typeof Database>;
let server: KernelHttpServer;
let base = "";
let actions: RpcAction[] = [];
const events = new EventBus();

const rpc = (name: string, args: Record<string, unknown> = {}) => {
  const action = actions.find((a) => a.name === name);
  if (!action) throw new Error(`no RPC action ${name}`);
  return action.handler(args);
};
const http = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(async () => {
  db = new Database(":memory:");
  server = new KernelHttpServer({ config });
});
afterEach(async () => {
  await server.stop();
  db.close();
});

async function start() {
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

describe("marketplace operations answer alike over RPC and HTTP", () => {
  let service: MarketplaceService;
  beforeEach(async () => {
    runMigrations(db, "marketplace", marketplaceMigrations);
    service = new MarketplaceService(db, events);
    seedDefaultThemes(db);
    actions = marketplaceDashboardRpcActions({ marketplaceService: service });
    registerMarketplaceRoutes(server, service, db);
    await start();
  });

  it("list returns the full payload over RPC too (it used to be items + total only)", async () => {
    const viaRpc = await rpc("marketplace.list") as Record<string, unknown>;
    const viaHttp = await (await http("GET", "/api/marketplace")).json() as Record<string, unknown>;
    expect(Object.keys(viaRpc).sort()).toEqual(Object.keys(viaHttp).sort());
    expect(viaRpc).toHaveProperty("stats");
    expect(viaRpc).toHaveProperty("themes");
  });

  it("a missing item is an error over RPC, not a resolved { error } the page took for success", async () => {
    await expect(rpc("marketplace.install", { id: "nope" })).rejects.toThrow("Item not found");
    const res = await http("POST", "/api/marketplace/install", { id: "nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Item not found" });
  });
});

describe("chat operations answer alike over RPC and HTTP", () => {
  let service: ChatService;
  beforeEach(async () => {
    runMigrations(db, "chat", chatMigrations);
    service = new ChatService(db, () => null, events, config);
    actions = chatDashboardRpcActions({ chatService: service });
    registerChatRoutes(server, service, events);
    await start();
  });

  it("episodes and messages come back in the same shape on both roads", async () => {
    const ep = service.createEpisode({ title: "T" });
    expect(await rpc("chat.episodes.list")).toEqual(await (await http("GET", "/api/chat/episodes")).json());
    expect(await rpc("chat.messages.list", { episode_id: ep.id }))
      .toEqual(await (await http("GET", `/api/chat/messages?episode_id=${ep.id}`)).json());
  });

  it("start returns the episode itself on both roads", async () => {
    const viaRpc = await rpc("chat.episode.start", { title: "R", instructions: "be brief" }) as { id: string };
    const viaHttp = await (await http("POST", "/api/chat/start", { title: "H" })).json() as { id: string };
    expect(service.getEpisode(viaRpc.id)?.title).toBe("R");
    expect(service.getEpisode(viaHttp.id)?.title).toBe("H");
  });

  it("send over RPC accepts an attachment-only message (it used to require text and drop attachments)", async () => {
    const image = { data: "aGk=", media_type: "image/png" };
    // Past validation: the next failure is the unknown episode, not the missing text.
    await expect(rpc("chat.message.send", { episode_id: "nope", images: [image] })).rejects.toThrow("Episode not found");
    await expect(rpc("chat.message.send", { episode_id: "nope" }))
      .rejects.toThrow("episode_id and message (or attachment) required");
    expect((await http("POST", "/api/chat/message", { episode_id: "nope" })).status).toBe(400);
  });
});

describe("news operations answer alike over RPC and HTTP", () => {
  let service: NewsService;
  beforeEach(async () => {
    runMigrations(db, "news", newsMigrations);
    service = new NewsService(db);
    actions = newsDashboardRpcActions({ newsService: service });
    registerNewsRoutes(server, service, events);
    await start();
  });

  it("assignFeeds over RPC reads the id/feed_ids the page sends (it read columnId/feedIds and no-op'd)", async () => {
    const col = service.createColumn({ name: "C" });
    const out = await rpc("news.columns.assignFeeds", { id: col.id, feed_ids: ["f1"] }) as { column: unknown };
    expect(out.column).toBeTruthy();
    expect(db.query("SELECT feed_id FROM news_column_feeds WHERE column_id = ?").all(col.id)).toEqual([{ feed_id: "f1" }]);
  });

  it("assignFeeds without feed_ids is a 400 on both roads, never a silent clear", async () => {
    const col = service.createColumn({ name: "C" });
    await expect(rpc("news.columns.assignFeeds", { id: col.id })).rejects.toThrow("feed_ids");
    expect((await http("PUT", `/api/news/columns/${col.id}/feeds`, {})).status).toBe(400);
    expect((await http("PUT", `/api/news/columns/${col.id}/feeds`)).status).toBe(400);
  });

  it("feeds.add validates the URL over RPC too", async () => {
    await expect(rpc("feeds.add", { name: "F", url: "not a url" })).rejects.toThrow("Invalid URL format");
    expect((await http("POST", "/api/feeds", { name: "F", url: "not a url" })).status).toBe(400);
    const created = await http("POST", "/api/news/columns", { name: "C" });
    expect(created.status).toBe(201);
  });
});

describe("twitter operations answer alike over RPC and HTTP", () => {
  let service: TwitterService;
  beforeEach(async () => {
    runMigrations(db, "twitter", twitterMigrations);
    service = new TwitterService(db, config);
    const publisher = {
      publishNow: async () => ({ ok: false, error: "no credentials" }),
      syncMetrics: async () => 0,
      checkMentions: async () => 0,
    } as unknown as TwitterPublisher;
    actions = twitterDashboardRpcActions({ db, twitterService: service, twitterPublisher: publisher });
    registerTwitterRoutes(server, service, publisher);
    await start();
  });

  it("account create keeps role/driver on both roads (the RPC list dropped them)", async () => {
    const viaRpc = await rpc("twitter.accounts.create", { handle: "r", role: "founder", driver: "xactions" }) as { id: string };
    const viaHttp = await (await http("POST", "/api/twitter/accounts", { handle: "h", role: "founder", driver: "xactions" })).json() as { id: string };
    for (const id of [viaRpc.id, viaHttp.id]) {
      expect(service.getAccount(id)?.role).toBe("founder");
      expect(service.getAccount(id)?.driver).toBe("xactions");
    }
  });

  it("a failed publish throws over RPC and keeps its 400 { error } body over HTTP", async () => {
    const acc = service.addAccount({ handle: "a" });
    const post = service.createPost({ account_id: acc.id, content: "x" });
    await expect(rpc("twitter.posts.publish", { id: post.id })).rejects.toThrow("no credentials");
    const res = await http("POST", "/api/twitter/posts/publish", { id: post.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no credentials" });
  });

  it("a non-string field never reaches the service", async () => {
    const acc = service.addAccount({ handle: "a" });
    await rpc("twitter.accounts.update", { id: acc.id, handle: 42, display_name: "D" });
    expect(service.getAccount(acc.id)?.handle).toBe("a");
    expect(service.getAccount(acc.id)?.display_name).toBe("D");
  });

  const SECRETS = {
    api_key: "key-SECRET-1", api_secret: "sec-SECRET-2",
    access_token: "tok-SECRET-3", access_secret: "acs-SECRET-4",
  };

  it("no response that reaches the dashboard carries a credential", async () => {
    const created = await rpc("twitter.accounts.create", { handle: "s", ...SECRETS }) as { id: string };
    service.updateAccount(created.id, { auth_cookie_ref: "cookie-SECRET-5" });
    const viaHttp = await (await http("POST", "/api/twitter/accounts", { handle: "t", ...SECRETS })).text();
    const responses = [
      JSON.stringify(created),
      viaHttp,
      JSON.stringify(await rpc("twitter.accounts.update", { id: created.id, display_name: "S" })),
      await (await http("POST", "/api/twitter/accounts/update", { id: created.id, role: "founder" })).text(),
      await (await http("GET", "/api/twitter/accounts")).text(),
      JSON.stringify(await rpc("dashboard.twitter")),
    ];
    for (const body of responses) expect(body).not.toContain("SECRET");
    const listed = await (await http("GET", "/api/twitter/accounts")).json() as Array<Record<string, unknown>>;
    const acc = listed.find((a) => a.id === created.id)!;
    expect(acc.api_secret).toBe("••••");
    expect(acc.has_api_secret).toBe(true);
    expect(acc.has_auth_cookie_ref).toBe(true);
  });

  it("an update with the mask or a blank keeps the stored secret", async () => {
    const acc = service.addAccount({ handle: "k", ...SECRETS });
    await rpc("twitter.accounts.update", { id: acc.id, display_name: "K", api_key: "••••", api_secret: "" });
    await http("POST", "/api/twitter/accounts/update", { id: acc.id, access_token: "••••", access_secret: "" });
    const stored = service.getAccount(acc.id)!;
    expect(stored.display_name).toBe("K");
    expect({ api_key: stored.api_key, api_secret: stored.api_secret, access_token: stored.access_token, access_secret: stored.access_secret })
      .toEqual(SECRETS);
  });

  it("an update with a new value replaces the stored secret", async () => {
    const acc = service.addAccount({ handle: "n", ...SECRETS });
    await rpc("twitter.accounts.update", { id: acc.id, api_secret: "new-secret" });
    await http("POST", "/api/twitter/accounts/update", { id: acc.id, access_token: "new-token" });
    expect(service.getAccount(acc.id)?.api_secret).toBe("new-secret");
    expect(service.getAccount(acc.id)?.access_token).toBe("new-token");
    expect(service.getAccount(acc.id)?.api_key).toBe(SECRETS.api_key);
  });
});

describe("api-registry and google operations answer alike over RPC and HTTP", () => {
  it("registry.apis.test without an id is an error on the RPC, not a resolved { error }", async () => {
    runMigrations(db, "api-registry", apiRegistryMigrations);
    const service = new ApiRegistryService(db, "");
    actions = apiRegistryDashboardRpcActions({ apiRegistryService: service });
    registerApiRegistryRoutes(server, service);
    await start();
    await expect(rpc("registry.apis.test", {})).rejects.toThrow("id is required");
    expect(await rpc("registry.apis.list")).toEqual(await (await http("GET", "/api/registry/apis")).json());
  });

  it("google.auth.start without credentials is the same 400 message on both roads", async () => {
    runMigrations(db, "google-sync", googleSyncMigrations);
    actions = googleSyncDashboardRpcActions({ db, config });
    registerGoogleOAuthRoutes(server, db, config);
    await start();
    const res = await http("POST", "/api/google/auth/start");
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    await expect(rpc("google.auth.start")).rejects.toThrow(error);
  });
});

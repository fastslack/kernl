// services/kernel/src/core/social-net/file-lane/index.ts
/**
 * The file-lane: friend-to-friend text and files over peering. Built ahead of
 * the social-net subprojects (see docs/superpowers/specs/2026-10-06-kernl-
 * file-lane-design.md), which reuse it as their file transport.
 */
import { join } from "node:path";
import type { KernelHttpServer } from "../../http-server.js";
import type { SqliteDb } from "../../db/sqlite.js";
import type { FriendsStore } from "../../peering/friends-store.js";
import type { PeerClient } from "../../peering/client.js";
import { log } from "../../logger.js";
import { TransferStore, type Transfer } from "./store.js";
import { TransferReceiver } from "./receiver.js";
import { TransferWorker } from "./worker.js";
import { TransferOwner } from "./owner.js";
import { registerTransferPeerRoutes } from "./peer-routes.js";
import { registerTransferOwnerRoutes } from "./owner-routes.js";

type Notify = { send(n: { title: string; body?: string; source?: string; priority?: "low" | "normal" | "high" }): Promise<boolean> };

export function startFileLane(opts: {
  server: KernelHttpServer;
  sqlite: SqliteDb;
  dataDir: string;
  peering: { friends: FriendsStore; client: PeerClient };
  notifier?: Notify;
  lang: "es" | "en";
  allowedRoots: string[];
}): { owner: TransferOwner; worker: TransferWorker } {
  const store = new TransferStore(opts.sqlite);
  const receiver = new TransferReceiver({
    store,
    friends: opts.peering.friends,
    dataDir: opts.dataDir,
    notify: (t) => void opts.notifier?.send(notification(t, store, opts.peering.friends, opts.lang)).catch(() => false),
  });
  const worker = new TransferWorker({ store, peer: opts.peering.client, dataDir: opts.dataDir });
  const owner = new TransferOwner({
    store, receiver, worker, friends: opts.peering.friends, dataDir: opts.dataDir,
    allowedRoots: [...opts.allowedRoots, join(opts.dataDir, "transfers", "incoming")],
  });
  registerTransferPeerRoutes(opts.server, { receiver, friends: opts.peering.friends });
  registerTransferOwnerRoutes(opts.server, owner);
  worker.start();
  const hk = setInterval(() => { void worker.housekeeping().catch((e) => log.warn(`file-lane: housekeeping ${String(e)}`)); }, 15 * 60_000);
  hk.unref?.();
  log.info("file-lane: friend-to-friend sharing ready");
  return { owner, worker };
}

function notification(t: Transfer, store: TransferStore, friends: FriendsStore, lang: "es" | "en") {
  const who = friends.get(t.peer_npub)?.petname || (lang === "es" ? "Un amigo" : "A friend");
  const files = store.files(t.id).length;
  const title = files === 0
    ? (lang === "es" ? `${who} te mandó un mensaje` : `${who} sent you a message`)
    : t.state === "pending"
      ? (lang === "es" ? `${who} quiere mandarte ${files} archivo(s)` : `${who} wants to send you ${files} file(s)`)
      : (lang === "es" ? `${who} te está mandando ${files} archivo(s)` : `${who} is sending you ${files} file(s)`);
  return { title, body: t.text ? t.text.slice(0, 200) : undefined, source: "share", priority: "normal" as const };
}

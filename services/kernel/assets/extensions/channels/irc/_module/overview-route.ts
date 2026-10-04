/**
 * GET /api/irc/overview — what the Social overview shows for IRC: how many
 * channels, whether the external networks are up, how much people talked
 * today, and the latest few lines.
 *
 * The kernel posts its own NOTICEs (daily summaries…) into every office
 * channel at once; counted as conversation they drown out the real messages,
 * so "activity" here is everything except those.
 */

import type { KernelHttpServer, SqliteDb } from "@kernl/extension-sdk";
import type { UpstreamManager } from "./upstream/manager.js";

const NOT_KERNEL_NOTICE = "NOT (sender = 'kernel' AND kind = 'NOTICE') AND deleted_at IS NULL";
const RECENT = 5;

export interface IrcOverview {
  channels: number;
  networks: Array<{ label: string; network: string; state: string; enabled: boolean; lastError: string }>;
  today: number;
  lastActivity: string | null;
  recent: Array<{ channel: string; sender: string; text: string; ts: string }>;
}

export function ircOverview(db: SqliteDb, upstream: Pick<UpstreamManager, "status"> | null, now = new Date()): IrcOverview {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const channels = (db.prepare("SELECT COUNT(*) AS n FROM irc_channels").get() as { n: number }).n;
  const today = (db.prepare(`SELECT COUNT(*) AS n FROM irc_messages WHERE ${NOT_KERNEL_NOTICE} AND ts >= ?`)
    .get(dayStart.toISOString()) as { n: number }).n;
  const last = db.prepare(`SELECT MAX(ts) AS ts FROM irc_messages WHERE ${NOT_KERNEL_NOTICE}`).get() as { ts: string | null };
  // Encrypted payloads are ciphertext: say so instead of printing it.
  const recent = (db.prepare(
    `SELECT target AS channel, sender, payload, encrypted, ts FROM irc_messages
      WHERE ${NOT_KERNEL_NOTICE} AND target LIKE '#%'
      ORDER BY ts DESC LIMIT ?`,
  ).all(RECENT) as Array<{ channel: string; sender: string; payload: string; encrypted: number; ts: string }>)
    .map((m) => ({
      channel: m.channel,
      sender: m.sender,
      text: m.encrypted ? "(encrypted)" : m.payload.split("\n")[0].slice(0, 160),
      ts: m.ts,
    }));
  const networks = (upstream?.status() ?? []).map((u) => ({
    label: u.label || u.network,
    network: u.network,
    state: u.state,
    enabled: u.enabled,
    lastError: u.lastError ?? "",
  }));
  return { channels, networks, today, lastActivity: last.ts, recent };
}

export function registerOverviewRoute(server: KernelHttpServer, db: SqliteDb, upstream: Pick<UpstreamManager, "status"> | null): void {
  server.route("GET", "/api/irc/overview", () => ircOverview(db, upstream));
}

import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { IrcServer } from "./server/ircd.js";
import type { IrcStore } from "./store.js";
import type { ChannelBridge } from "./bridge/channel-bridge.js";
import type { OfficeBridge } from "./bridge/office-bridge.js";

export function ircTools(deps: {
  server: IrcServer;
  store: IrcStore;
  channelBridge: ChannelBridge;
  officeBridge: OfficeBridge;
}): ToolDefinition[] {
  const { server, store, channelBridge, officeBridge } = deps;
  return [
    {
      name: "kernel_irc_status",
      description: "Show IRC server status: connected clients, agents, channels.",
      inputSchema: z.object({}),
      handler: async () => {
        const s = server.stats();
        return textResult(
          `IRC server\n  clients: ${s.clients}\n  agents:  ${s.agents}\n  channels: ${s.channels}\n  nicks:   ${s.nicks}`,
        );
      },
    },
    {
      name: "kernel_irc_channels",
      description: "List IRC channels with member counts, topics, office/E2E flags.",
      inputSchema: z.object({}),
      handler: async () => {
        const chans = server.listChannelNames();
        if (chans.length === 0) return textResult("No channels.");
        return textResult(
          chans
            .map((c) => `${c.name} (${c.members}) ${c.office ? "[office]" : ""}${c.e2e ? "[+E]" : ""}${c.topic ? " — " + c.topic : ""}`)
            .join("\n"),
        );
      },
    },
    {
      name: "kernel_irc_history",
      description: "Read recent scrollback for an IRC channel or nick (bouncer/CHATHISTORY).",
      inputSchema: z.object({
        target: z.string().describe("Channel (#name) or nick"),
        limit: z.number().optional().describe("Max messages (default 50)"),
      }),
      handler: async (args) => {
        const { target, limit } = args as { target: string; limit?: number };
        const rows = store.history(target, Math.min(limit ?? 50, 500));
        if (rows.length === 0) return textResult(`No history for ${target}.`);
        return textResult(
          rows
            .map((r) => `[${r.ts}] <${r.sender}> ${r.encrypted ? "🔒(encrypted)" : r.payload}`)
            .join("\n"),
        );
      },
    },
    {
      name: "kernel_irc_say",
      description: "Post a message into an IRC channel as the kernel service user.",
      inputSchema: z.object({
        channel: z.string().describe("Channel (#name)"),
        text: z.string().describe("Message text"),
        notice: z.boolean().optional().describe("Send as NOTICE instead of PRIVMSG"),
      }),
      handler: async (args) => {
        const { channel, text, notice } = args as { channel: string; text: string; notice?: boolean };
        if (!server.listChannelNames().some((c) => c.name.toLowerCase() === (channel.startsWith("#") ? channel : "#" + channel).toLowerCase())) {
          return errorResult(`No such channel: ${channel}`);
        }
        server.postToChannel("kernel", channel, text, { kind: notice ? "NOTICE" : "PRIVMSG" });
        return textResult(`Posted to ${channel}.`);
      },
    },
    {
      name: "kernel_irc_broadcast",
      description: "Broadcast a NOTICE to every IRC channel.",
      inputSchema: z.object({ text: z.string() }),
      handler: async (args) => {
        const { text } = args as { text: string };
        const n = server.broadcastNotice("kernel", text);
        return textResult(`Broadcast to ${n} channels.`);
      },
    },
    {
      name: "kernel_irc_ban",
      description: "Add a ban mask (nick!user@host) to an IRC channel.",
      inputSchema: z.object({
        channel: z.string(),
        mask: z.string().describe("Ban mask, e.g. baduser!*@*"),
      }),
      handler: async (args) => {
        const { channel, mask } = args as { channel: string; mask: string };
        store.addBan(channel.startsWith("#") ? channel : "#" + channel, mask, "kernel");
        return textResult(`Banned ${mask} from ${channel}.`);
      },
    },
    {
      name: "kernel_irc_grant_cert",
      description: "Register a TLS client-cert fingerprint (CertFP) for an account (SASL EXTERNAL).",
      inputSchema: z.object({
        fingerprint: z.string().describe("SHA-256 fingerprint, hex (no colons)"),
        account: z.string(),
        label: z.string().optional(),
      }),
      handler: async (args) => {
        const { fingerprint, account, label } = args as { fingerprint: string; account: string; label?: string };
        store.addCert(fingerprint, account, label ?? "");
        store.upsertAccount({ account, nick: account });
        return textResult(`CertFP registered: ${fingerprint.slice(0, 16)}… → ${account}`);
      },
    },
    {
      name: "kernel_irc_bridge_add",
      description: "Bridge an IRC channel to an external messaging channel (telegram/slack/discord/webchat).",
      inputSchema: z.object({
        irc_channel: z.string().describe("IRC channel (#name)"),
        provider: z.enum(["telegram", "slack", "discord", "webchat"]),
        target: z.string().describe("External chat/channel id"),
      }),
      handler: async (args) => {
        const { irc_channel, provider, target } = args as { irc_channel: string; provider: string; target: string };
        channelBridge.addMapping({ ircChannel: irc_channel, provider, target });
        return textResult(`Bridged ${irc_channel} ↔ ${provider}:${target}`);
      },
    },
    {
      name: "kernel_irc_bridge_inject",
      description: "Manually inject an external message into its bridged IRC channel (inbound mirror).",
      inputSchema: z.object({
        provider: z.string(),
        target: z.string(),
        sender: z.string(),
        text: z.string(),
      }),
      handler: async (args) => {
        const { provider, target, sender, text } = args as { provider: string; target: string; sender: string; text: string };
        const ok = channelBridge.injectFromExternal(provider, target, sender, text);
        return ok ? textResult("Injected.") : errorResult(`No bridge mapping for ${provider}:${target}`);
      },
    },
    {
      name: "kernel_irc_sync_offices",
      description: "Re-sync kernel offices → IRC channels and agents → IRC users.",
      inputSchema: z.object({}),
      handler: async () => {
        officeBridge.sync();
        return textResult("Offices synced.");
      },
    },
  ];
}

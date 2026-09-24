import { z } from "zod";
import { type ToolDefinition, defineTool, defineToolNoInput, textResult, errorResult, limitArg } from "@kernl/extension-sdk";
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
    defineToolNoInput({
      name: "kernel_irc_status",
      description: "Show IRC server status: connected clients, agents, channels.",
      handler: async () => {
        const s = server.stats();
        return textResult(
          `IRC server\n  clients: ${s.clients}\n  agents:  ${s.agents}\n  channels: ${s.channels}\n  nicks:   ${s.nicks}`,
        );
      },
    }),
    defineToolNoInput({
      name: "kernel_irc_channels",
      description: "List IRC channels with member counts, topics, office/E2E flags.",
      handler: async () => {
        const chans = server.listChannelNames();
        if (chans.length === 0) return textResult("No channels.");
        return textResult(
          chans
            .map((c) => `${c.name} (${c.members}) ${c.office ? "[office]" : ""}${c.e2e ? "[+E]" : ""}${c.topic ? " — " + c.topic : ""}`)
            .join("\n"),
        );
      },
    }),
    defineTool({
      name: "kernel_irc_history",
      description: "Read recent scrollback for an IRC channel or nick (bouncer/CHATHISTORY).",
      schema: z.object({
        target: z.string().describe("Channel (#name) or nick"),
        limit: limitArg(200, "Max messages (default 50)"),
      }),
      handler: async ({ target, limit }) => {
        const rows = store.history(target, Math.min(limit ?? 50, 500));
        if (rows.length === 0) return textResult(`No history for ${target}.`);
        return textResult(
          rows
            .map((r) => `[${r.ts}] <${r.sender}> ${r.encrypted ? "🔒(encrypted)" : r.payload}`)
            .join("\n"),
        );
      },
    }),
    defineTool({
      name: "kernel_irc_say",
      description: "Post a message into an IRC channel as the kernel service user.",
      schema: z.object({
        channel: z.string().describe("Channel (#name)"),
        text: z.string().describe("Message text"),
        notice: z.boolean().optional().describe("Send as NOTICE instead of PRIVMSG"),
      }),
      handler: async ({ channel, text, notice }) => {
        if (!server.listChannelNames().some((c) => c.name.toLowerCase() === (channel.startsWith("#") ? channel : "#" + channel).toLowerCase())) {
          return errorResult(`No such channel: ${channel}`);
        }
        server.postToChannel("kernel", channel, text, { kind: notice ? "NOTICE" : "PRIVMSG" });
        return textResult(`Posted to ${channel}.`);
      },
    }),
    defineTool({
      name: "kernel_irc_broadcast",
      description: "Broadcast a NOTICE to every IRC channel.",
      schema: z.object({ text: z.string() }),
      handler: async ({ text }) => {
        const n = server.broadcastNotice("kernel", text);
        return textResult(`Broadcast to ${n} channels.`);
      },
    }),
    defineTool({
      name: "kernel_irc_ban",
      description: "Add a ban mask (nick!user@host) to an IRC channel.",
      schema: z.object({
        channel: z.string(),
        mask: z.string().describe("Ban mask, e.g. baduser!*@*"),
      }),
      handler: async ({ channel, mask }) => {
        store.addBan(channel.startsWith("#") ? channel : "#" + channel, mask, "kernel");
        return textResult(`Banned ${mask} from ${channel}.`);
      },
    }),
    defineTool({
      name: "kernel_irc_grant_cert",
      description: "Register a TLS client-cert fingerprint (CertFP) for an account (SASL EXTERNAL).",
      schema: z.object({
        fingerprint: z.string().describe("SHA-256 fingerprint, hex (no colons)"),
        account: z.string(),
        label: z.string().optional(),
      }),
      handler: async ({ fingerprint, account, label }) => {
        store.addCert(fingerprint, account, label ?? "");
        store.upsertAccount({ account, nick: account });
        return textResult(`CertFP registered: ${fingerprint.slice(0, 16)}… → ${account}`);
      },
    }),
    defineTool({
      name: "kernel_irc_bridge_add",
      description: "Bridge an IRC channel to an external messaging channel (telegram/slack/discord/webchat).",
      schema: z.object({
        irc_channel: z.string().describe("IRC channel (#name)"),
        provider: z.enum(["telegram", "slack", "discord", "webchat"]),
        target: z.string().describe("External chat/channel id"),
      }),
      handler: async ({ irc_channel, provider, target }) => {
        channelBridge.addMapping({ ircChannel: irc_channel, provider, target });
        return textResult(`Bridged ${irc_channel} ↔ ${provider}:${target}`);
      },
    }),
    defineTool({
      name: "kernel_irc_bridge_inject",
      description: "Manually inject an external message into its bridged IRC channel (inbound mirror).",
      schema: z.object({
        provider: z.string(),
        target: z.string(),
        sender: z.string(),
        text: z.string(),
      }),
      handler: async ({ provider, target, sender, text }) => {
        const ok = channelBridge.injectFromExternal(provider, target, sender, text);
        return ok ? textResult("Injected.") : errorResult(`No bridge mapping for ${provider}:${target}`);
      },
    }),
    defineToolNoInput({
      name: "kernel_irc_sync_offices",
      description: "Re-sync kernel offices → IRC channels and agents → IRC users.",
      handler: async () => {
        officeBridge.sync();
        return textResult("Offices synced.");
      },
    }),
  ];
}

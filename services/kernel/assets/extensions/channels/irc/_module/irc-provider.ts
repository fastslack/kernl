/**
 * IRC NotificationProvider — the registry-facing channel object. Owns the
 * lifecycle of the TLS/WS transport and exposes the kernel server as both a
 * notification sink (sendNotification/sendTo) and an interactive channel
 * (getTransport for message-routing).
 */
import type { Server as HttpServer } from "node:http";
import type {
  NotificationProvider,
  NotificationPayload,
  ProviderStatus,
  ProviderCapability,
  ConfigField,
} from "../../../../../src/core/notify/provider.js";
import type { ChannelTransport } from "../../../../../src/channels/types.js";
import { log } from "../../../../../src/core/logger.js";
import { IrcServer } from "./server/ircd.js";
import { IrcTransport } from "./irc-transport.js";
import type { OfficeBridge } from "./bridge/office-bridge.js";
import type { ChannelBridge } from "./bridge/channel-bridge.js";
import type { SaslAuthenticator } from "./security/sasl.js";
import type { UpstreamManager } from "./upstream/manager.js";

export interface IrcRuntimeConfig {
  tlsPort: number;
  wsPath: string;
  serverName: string;
  networkName: string;
  botNick: string;
  motd: string;
  requireSasl: boolean;
  requireClientCert: boolean;
  historyLimit: number;
  dataDir: string;
  tlsCert?: string;
  tlsKey?: string;
  saslPassword?: string;
}

export class IrcProvider implements NotificationProvider {
  readonly id = "irc";
  readonly name = "IRC";
  readonly icon = "📡";
  readonly capabilities: ProviderCapability[] = ["notify", "receive"];

  private transport: IrcTransport | null = null;
  private httpServer: HttpServer | null = null;
  private ready = false;
  private error: string | undefined;

  constructor(
    private deps: {
      server: IrcServer;
      cfg: IrcRuntimeConfig;
      officeBridge: OfficeBridge;
      channelBridge: ChannelBridge;
      sasl: SaslAuthenticator;
      /** The bouncer. Absent only in tests that exercise the server alone. */
      upstream?: UpstreamManager;
    },
  ) {}

  getConfigSchema(): ConfigField[] {
    return [
      { key: "tlsPort", label: "TLS Port", type: "number", required: false, default: 6697, description: "Port for ircs:// (TLS) connections" },
      { key: "serverName", label: "Server Name", type: "text", required: false, default: "irc.kernl", group: "identity" },
      { key: "networkName", label: "Network Name", type: "text", required: false, default: "Kernl", group: "identity" },
      { key: "botNick", label: "Service Nick", type: "text", required: false, default: "kernel", description: "Nick used for kernel notifications/replies" },
      { key: "motd", label: "MOTD", type: "textarea", required: false },
      { key: "requireSasl", label: "Require SASL login", type: "boolean", required: false, default: false, group: "security" },
      { key: "requireClientCert", label: "Require client certificate (CertFP)", type: "boolean", required: false, default: false, group: "security" },
      { key: "saslPassword", label: "SASL PLAIN password", type: "password", required: false, description: "Shared password for SASL PLAIN (or wire the vault verifier)", group: "security" },
      { key: "tlsCert", label: "TLS certificate (PEM)", type: "textarea", required: false, group: "security" },
      { key: "tlsKey", label: "TLS private key (PEM)", type: "password", required: false, group: "security" },
      { key: "historyLimit", label: "CHATHISTORY limit", type: "number", required: false, default: 200 },
    ];
  }

  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    if (config.requireClientCert && !(config.tlsCert && config.tlsKey)) {
      // CertFP needs a CA-less mutual-TLS setup but still works with a self-signed
      // server cert; just warn rather than block.
    }
    const port = Number(config.tlsPort ?? 6697);
    if (port < 1 || port > 65535) errors.push("tlsPort out of range");
    return { valid: errors.length === 0, errors: errors.length ? errors : undefined };
  }

  configure(config: Record<string, unknown>): void {
    const c = this.deps.cfg;
    if (config.tlsPort !== undefined) c.tlsPort = Number(config.tlsPort);
    if (config.serverName) c.serverName = String(config.serverName);
    if (config.networkName) c.networkName = String(config.networkName);
    if (config.botNick) c.botNick = String(config.botNick);
    if (config.motd !== undefined) c.motd = String(config.motd);
    if (config.requireSasl !== undefined) c.requireSasl = !!config.requireSasl;
    if (config.requireClientCert !== undefined) c.requireClientCert = !!config.requireClientCert;
    if (config.saslPassword) c.saslPassword = String(config.saslPassword);
    if (config.tlsCert) c.tlsCert = String(config.tlsCert);
    if (config.tlsKey) c.tlsKey = String(config.tlsKey);
    if (config.historyLimit !== undefined) c.historyLimit = Number(config.historyLimit);

    if (c.saslPassword) this.deps.sasl.setVerifier((_authcid, passwd) => passwd === c.saslPassword);
  }

  setHttpServer(server: HttpServer): void {
    this.httpServer = server;
  }

  async start(): Promise<void> {
    try {
      const c = this.deps.cfg;
      this.transport = new IrcTransport(this.deps.server, {
        tlsPort: c.tlsPort,
        wsPath: c.wsPath,
        botNick: c.botNick,
        tlsCert: c.tlsCert,
        tlsKey: c.tlsKey,
        dataDir: c.dataDir,
      });
      this.transport.officeHandler = (ev) => this.deps.officeBridge.handle(ev);
      this.transport.bridgeHandler = (ev) => {
        if (this.deps.channelBridge.isBridged(ev.target)) {
          this.deps.channelBridge.forwardToExternal(ev.target, ev.from.nick, ev.text);
        }
      };
      this.transport.upstreamHandler = (ev) => this.deps.upstream?.handleOutbound(ev) ?? false;
      if (this.httpServer) this.transport.setHttpServer(this.httpServer);
      await this.transport.start();
      this.deps.officeBridge.sync();
      // The bouncer outlives any dashboard session: it connects here and only
      // stops with the provider.
      this.deps.upstream?.start();
      this.ready = true;
      this.error = undefined;
      log.info("IRC: provider started");
    } catch (err) {
      this.error = String(err);
      this.ready = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.deps.upstream?.stop();
    if (this.transport) {
      await this.transport.stop();
      this.transport = null;
    }
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready && this.transport !== null;
  }

  getStatus(): ProviderStatus {
    const s = this.deps.server.stats();
    return {
      id: this.id,
      name: this.name,
      icon: this.icon,
      connected: this.isReady(),
      enabled: true,
      error: this.error,
      capabilities: this.capabilities,
      info: { clients: s.clients, agents: s.agents, channels: s.channels },
    };
  }

  async sendNotification(payload: NotificationPayload): Promise<boolean> {
    const text = payload.title ? `${payload.title}${payload.body ? " — " + payload.body : ""}` : payload.body ?? "";
    if (!text) return false;
    this.deps.server.broadcastNotice(this.deps.cfg.botNick, text);
    return true;
  }

  async sendTo(target: string, payload: NotificationPayload): Promise<boolean> {
    const text = payload.title ? `${payload.title}${payload.body ? " — " + payload.body : ""}` : payload.body ?? "";
    if (!text) return false;
    if (target.startsWith("#")) {
      this.deps.server.postToChannel(this.deps.cfg.botNick, target, text, { kind: "NOTICE" });
      return true;
    }
    return this.deps.server.postToNick(this.deps.cfg.botNick, target, text, "NOTICE");
  }

  getTransport(): ChannelTransport | null {
    return this.transport;
  }
}

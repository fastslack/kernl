import type { Server as HttpServer } from "node:http";
import type {
  NotificationProvider,
  NotificationPayload,
  ProviderStatus,
  ProviderCapability,
  ConfigField,
} from "../../../../../src/core/notify/provider.js";
import type { ChannelTransport } from "../../../../../src/channels/types.js";

export class WebChatProvider implements NotificationProvider {
  readonly id = "webchat";
  readonly name = "WebChat";
  readonly icon = "💬";
  readonly capabilities: ProviderCapability[] = ["receive", "buttons"];

  private transport: ChannelTransport | null = null;
  private config: Record<string, unknown> = {};
  private httpServer: HttpServer | null = null;
  private ready = false;
  private error: string | undefined;

  getConfigSchema(): ConfigField[] {
    return [
      { key: "requireAuth", label: "Require Authentication", type: "boolean", required: false, default: false },
      { key: "apiKey", label: "API Key", type: "password", required: false, description: "Required only if authentication is enabled" },
    ];
  }

  validateConfig(_config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    return { valid: true };
  }

  configure(config: Record<string, unknown>): void {
    this.config = config;
  }

  /** Set HTTP server reference for WebSocket attachment */
  setHttpServer(server: HttpServer): void {
    this.httpServer = server;
  }

  async start(): Promise<void> {
    try {
      const { WebChatTransport } = await import("./webchat-transport.js");
      this.transport = new WebChatTransport({
        enabled: true,
        requireAuth: !!this.config.requireAuth,
        apiKey: (this.config.apiKey as string) || undefined,
      });
      // WebChat needs HTTP server to attach WS upgrade handler
      if (this.httpServer && (this.transport as any).attachToServer) {
        (this.transport as any).attachToServer(this.httpServer);
      }
      await this.transport.start();
      this.ready = this.transport.isReady();
      this.error = undefined;
    } catch (err) {
      this.error = String(err);
      this.ready = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
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
    return {
      id: this.id,
      name: this.name,
      icon: this.icon,
      connected: this.isReady(),
      enabled: true,
      error: this.error,
      capabilities: this.capabilities,
    };
  }

  // WebChat is receive-only — no proactive notifications
  async sendNotification(_payload: NotificationPayload): Promise<boolean> {
    return false;
  }

  getTransport(): ChannelTransport | null {
    return this.transport;
  }
}

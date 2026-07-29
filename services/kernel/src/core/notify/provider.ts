/**
 * Unified notification/channel provider interface.
 * All communication channels (Telegram, Mattermost, WhatsApp, Slack, Discord, Dashboard)
 * implement this interface and are managed by the NotificationRegistry.
 */

// ── Capabilities ──────────────────────────────────────────────

export type ProviderCapability = "notify" | "receive" | "buttons" | "media" | "typing" | "reactions" | "voice";

// ── Status ────────────────────────────────────────────────────

export interface ProviderStatus {
  id: string;
  name: string;
  icon: string;
  connected: boolean;
  enabled: boolean;
  error?: string;
  capabilities: ProviderCapability[];
  info?: Record<string, unknown>;
}

// ── Notification Payload ──────────────────────────────────────

export interface NotificationPayload {
  title: string;
  body?: string;
  priority?: "low" | "normal" | "high";
  silent?: boolean;
  source?: string;
  format?: "plain" | "markdown" | "html";
}

// ── Config Form Schema ────────────────────────────────────────

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean" | "select" | "textarea";
  required: boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  default?: string | number | boolean;
  group?: string;
}

// ── Provider Interface ────────────────────────────────────────

export interface NotificationProvider {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly capabilities: ProviderCapability[];

  /** Schema describing config fields this provider needs (for dashboard config form) */
  getConfigSchema(): ConfigField[];

  /** Validate config before saving. Returns errors if invalid. */
  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] };

  /** Apply config and prepare the provider */
  configure(config: Record<string, unknown>): void;

  /** Start the provider (connect, authenticate) */
  start(): Promise<void>;

  /** Stop the provider */
  stop(): Promise<void>;

  /** Check if provider is ready to send */
  isReady(): boolean;

  /** Get current status */
  getStatus(): ProviderStatus;

  /** Send a notification to the default destination */
  sendNotification(payload: NotificationPayload): Promise<boolean>;

  /** Send to a specific target (chat ID, channel ID, webhook, etc.) */
  sendTo?(target: string, payload: NotificationPayload): Promise<boolean>;

  /** Send a test notification */
  sendTest?(): Promise<boolean>;
}

/** External agent platforms */
export type AgentPlatform = "telegram" | "http" | "mqtt";

/** Agent status */
export type AgentStatus = "online" | "offline" | "unknown" | "error";

/** Message types for agent communication */
export type AgentMessageType = "text" | "report" | "command" | "alert" | "metric";

/** External agent definition */
export interface ExternalAgent {
  id: string;
  name: string;
  description: string;
  platform: AgentPlatform;
  platform_id: string;           // Telegram user_id, webhook URL, MQTT topic, etc.
  capabilities: string;          // JSON array of capabilities
  api_key: string;               // For HTTP agents - API key for authentication
  last_seen_at: string | null;
  status: AgentStatus;
  config: string;                // JSON config
  created_at: string;
  updated_at: string;
}

/** Agent message (communication log) */
export interface AgentMessage {
  id: string;
  agent_id: string | null;       // NULL = from user
  direction: "inbound" | "outbound";
  message_type: AgentMessageType;
  content: string;
  metadata: string;              // JSON metadata
  created_at: string;
}

/** Metric data point from an agent */
export interface AgentMetric {
  id: string;
  agent_id: string;
  metric_name: string;
  metric_value: number;
  unit: string;
  recorded_at: string;
  created_at: string;
}

/** Alert from an agent */
export interface AgentAlert {
  id: string;
  agent_id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  acknowledged: number;          // 0/1
  acknowledged_at: string | null;
  created_at: string;
}

/** Parsed report from external agent */
export interface AgentReport {
  agent_id: string;
  type: "status" | "metrics" | "alert" | "log";
  title?: string;
  message?: string;
  metrics?: Array<{
    name: string;
    value: number;
    unit?: string;
  }>;
  severity?: "info" | "warning" | "critical";
  timestamp?: string;
}

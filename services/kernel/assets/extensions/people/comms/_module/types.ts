export type CommChannel = "email" | "whatsapp" | "mattermost" | "x" | "instagram" | "linkedin";
export type CommDirection = "inbound" | "outbound";
export type CommStatus = "draft" | "ready" | "sending" | "sent" | "failed" | "archived";

export type AccountType = "personal" | "work" | "transactional" | "marketing";
export type AccountProvider = "gmail" | "resend" | "imap_smtp";

export interface EmailAccount {
  id: string;
  label: string;
  email: string;
  type: AccountType;
  provider: AccountProvider;
  company: string;
  signature: string;
  provider_config: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface Communication {
  id: string;
  channel: CommChannel;
  direction: CommDirection;
  status: CommStatus;
  subject: string;
  body: string;
  body_html: string;
  contact_id: string | null;
  task_id: string | null;
  account_id: string | null;
  thread_id: string;
  in_reply_to: string;
  recipients_to: string;
  recipients_cc: string;
  recipients_bcc: string;
  gmail_message_id: string;
  gmail_thread_id: string;
  scheduled_at: string | null;
  sent_at: string | null;
  error_message: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface CommAttachment {
  id: string;
  comm_id: string;
  filename: string;
  original_path: string;
  stored_path: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface InboxMessage {
  gmail_id: string;
  gmail_thread_id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
}

export interface CommMetadata {
  from?: string;
  from_name?: string;
  message_id_header?: string;
  reply_to_message_id?: string;
  quoted_text?: string;
}

// ── Templates & Campaigns ─────────────────────

export type CampaignStatus = "draft" | "sending" | "sent" | "paused" | "cancelled";
export type RecipientStatus = "pending" | "sent" | "failed" | "skipped";

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  body_html: string;
  category: string;
  variables: string;
  account_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailCampaign {
  id: string;
  name: string;
  template_id: string | null;
  account_id: string | null;
  status: CampaignStatus;
  subject_override: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignRecipient {
  id: string;
  campaign_id: string;
  contact_id: string | null;
  email: string;
  name: string;
  variables: string;
  status: RecipientStatus;
  comm_id: string | null;
  sent_at: string | null;
  error_message: string;
  created_at: string;
}

// ── Email Client Types ───────────────────────

export type EmailActionType =
  | "note" | "label" | "follow_up" | "link_task" | "link_contact"
  | "block_sender" | "snooze" | "important" | "archive" | "trash";

export type EmailFolder =
  | "inbox" | "sent" | "starred" | "important" | "drafts"
  | "trash" | "archived" | "snoozed" | "all";

export interface EmailAction {
  id: string;
  gmail_id: string;
  action_type: EmailActionType;
  value: string;
  created_at: string;
}

export interface EmailLabel {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface EmailListItem {
  gmail_id: string;
  thread_id: string;
  from_email: string;
  from_name: string;
  to_emails: string;
  subject: string;
  snippet: string;
  date: string;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  labels: string;
  message_count: number;
  contact_name?: string;
  account_id?: string;
  // Triage fields
  urgency?: string;
  attention_needed?: number;
  ai_summary?: string;
  draft_comm_id?: string;
}

export interface EmailDetail {
  gmail_id: string;
  thread_id: string;
  from_email: string;
  from_name: string;
  to_emails: string;
  cc_emails: string;
  subject: string;
  snippet: string;
  body_text: string;
  date: string;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  labels: string;
  size_bytes: number;
  actions: EmailAction[];
  email_labels: EmailLabel[];
  linked_tasks: Array<{ id: string; title: string; status: string }>;
  linked_contacts: Array<{ id: string; name: string; email: string }>;
  // Triage fields
  urgency?: string;
  attention_needed?: number;
  ai_summary?: string;
  draft_comm_id?: string;
}

export interface ThreadDetail {
  thread_id: string;
  subject: string;
  messages: EmailDetail[];
}

export interface EmailCounts {
  inbox: number;
  unread: number;
  starred: number;
  sent: number;
  drafts: number;
  trash: number;
  archived: number;
  snoozed: number;
  important: number;
  attention: number;
}

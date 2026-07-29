// ── Stored in SQLite ────────────────────────────────────

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string;  // ISO 8601
  scopes: string;
  updated_at: string;
}

export type SyncSource = "contacts" | "calendar" | "tasks" | "gmail" | "other_contacts" | "takeout_places";

export interface SyncMapEntry {
  id: string;
  source: SyncSource;
  google_id: string;
  local_id: string;
  local_table: string;
  synced_at: string;
}

export interface SyncMeta {
  source: SyncSource;
  last_sync_at: string;
  items_synced: number;
}

// ── Google People API ──────────────────────────────────

export interface GooglePerson {
  resourceName: string;
  names?: Array<{ displayName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
  organizations?: Array<{ name?: string }>;
  biographies?: Array<{ value?: string }>;
}

export interface GooglePeopleResponse {
  connections?: GooglePerson[];
  nextPageToken?: string;
  totalPeople?: number;
}

// ── Google Calendar API ────────────────────────────────

export interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: {
    dateTime?: string;  // RFC 3339
    date?: string;      // YYYY-MM-DD (all-day)
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  recurrence?: string[];  // RRULE strings
  status?: string;
}

export interface GoogleCalendarResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

// ── Google Tasks API ───────────────────────────────────

export interface GoogleTaskList {
  id: string;
  title: string;
}

export interface GoogleTask {
  id: string;
  title?: string;
  notes?: string;
  due?: string;        // RFC 3339
  status?: string;     // "needsAction" | "completed"
  completed?: string;
}

export interface GoogleTaskListResponse {
  items?: GoogleTaskList[];
  nextPageToken?: string;
}

export interface GoogleTasksResponse {
  items?: GoogleTask[];
  nextPageToken?: string;
}

// ── Gmail API ──────────────────────────────────────────

export interface GmailMessage {
  id: string;
  threadId: string;
}

export interface GmailMessageDetail {
  id: string;
  threadId: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
  };
  internalDate: string;
}

export interface GmailMessagePart {
  mimeType: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessageFull {
  id: string;
  threadId: string;
  snippet: string;
  labelIds?: string[];
  internalDate: string;
  payload: GmailMessagePart & {
    headers: Array<{ name: string; value: string }>;
  };
}

export interface GmailListResponse {
  messages?: GmailMessage[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

// ── Google People API — Other Contacts ─────────────────

export interface GoogleOtherContact {
  resourceName: string;
  names?: Array<{ displayName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
}

// ── Google Takeout — Saved Places (GeoJSON) ────────────

export interface TakeoutFeature {
  type: "Feature";
  geometry?: {
    type: "Point";
    coordinates: [number, number]; // [lng, lat]
  };
  properties: {
    name?: string;
    address?: string;
    "google_maps_url"?: string;
    location?: {
      name?: string;
      address?: string;
      geo_coordinates?: { latitude: number; longitude: number };
    };
    date?: string;
    "Comment"?: string;  // e.g. "STARRED"
  };
}

export interface TakeoutGeoJSON {
  type: "FeatureCollection";
  features: TakeoutFeature[];
}

// ── Full Sync Types ──────────────────────────────────

export type FullSyncSource = SyncSource | "gmail_full" | "calendar_full";

export interface GoogleEmailFull {
  id: string;
  gmail_id: string;
  thread_id: string;
  from_email: string;
  from_name: string;
  to_emails: string;   // JSON [{email,name}]
  cc_emails: string;   // JSON [{email,name}]
  subject: string;
  snippet: string;
  body_text: string;
  labels: string;      // JSON [label_ids]
  date: string;
  size_bytes: number;
  has_attachments: number;
  is_read: number;
  is_starred: number;
  created_at: string;
}

export interface GoogleCalendarEventFull {
  id: string;
  google_event_id: string;
  calendar_id: string;
  title: string;
  description: string;
  location: string;
  start_at: string;
  end_at: string;
  all_day: number;
  status: string;
  organizer_email: string;
  organizer_name: string;
  attendees: string;       // JSON [{email,name,responseStatus}]
  recurrence: string;      // JSON [RRULE strings]
  recurring_event_id: string;
  hangout_link: string;
  visibility: string;
  created_at: string;
  updated_at: string;
}

export interface GraphSyncResult {
  emailNodes: number;
  threadNodes: number;
  calendarNodes: number;
  sentRels: number;
  receivedRels: number;
  partOfRels: number;
  attendsRels: number;
  organizedRels: number;
  emailedRels: number;
  metWithRels: number;
}

// ── Sync results ───────────────────────────────────────

export interface ImportResult {
  source: SyncSource | FullSyncSource;
  imported: number;
  skipped: number;
  errors: string[];
}

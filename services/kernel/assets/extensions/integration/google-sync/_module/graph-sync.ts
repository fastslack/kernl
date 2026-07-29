import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver, GraphResult } from "../../../../../src/core/db-drivers/graph-driver.js";
import { log } from "../../../../../src/core/logger.js";

const BATCH_SIZE = 200;

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

const EMPTY_RESULT: GraphSyncResult = {
  emailNodes: 0,
  threadNodes: 0,
  calendarNodes: 0,
  sentRels: 0,
  receivedRels: 0,
  partOfRels: 0,
  attendsRels: 0,
  organizedRels: 0,
  emailedRels: 0,
  metWithRels: 0,
};

/** Extract a single integer from a graph query result */
function getCount(result: GraphResult, key: string): number {
  const rec = result.records[0];
  if (!rec) return 0;
  const val = rec.get(key) as { toNumber?(): number } | number | null | undefined;
  if (typeof val === "number") return val;
  if (val && typeof (val as { toNumber?: () => number }).toNumber === "function") {
    return (val as { toNumber(): number }).toNumber();
  }
  return 0;
}

export class GoogleGraphSync {
  /**
   * The constructor takes a live getter for the active graph driver — every
   * method reads it fresh, so /extensions toggles take effect on the next
   * sync invocation. Methods gate on `cypher` capability and short-circuit
   * with empty results when the active driver can't service the query.
   */
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  /** Create uniqueness constraints for Google-synced nodes */
  async createConstraints(): Promise<void> {
    const graph = this.getGraph();
    if (!graph?.capabilities.cypher) return;

    const constraints = [
      "CREATE CONSTRAINT email_gmail_id IF NOT EXISTS FOR (e:Email) REQUIRE e.gmail_id IS UNIQUE",
      "CREATE CONSTRAINT thread_gmail_id IF NOT EXISTS FOR (t:EmailThread) REQUIRE t.gmail_thread_id IS UNIQUE",
      "CREATE CONSTRAINT calevent_google_id IF NOT EXISTS FOR (c:CalendarEvent) REQUIRE c.google_event_id IS UNIQUE",
    ];

    for (const cypher of constraints) {
      try {
        await graph.run(cypher);
      } catch (err) {
        // Constraint may already exist
        log.debug(`Constraint creation: ${err}`);
      }
    }
  }

  /** Full graph sync: nodes + direct rels + derived rels */
  async syncAll(): Promise<GraphSyncResult> {
    const graph = this.getGraph();
    if (!graph?.capabilities.cypher) {
      log.info("google-sync/graph-sync: active driver lacks cypher — skipping graph sync");
      return EMPTY_RESULT;
    }

    const result: GraphSyncResult = { ...EMPTY_RESULT };

    // Phase 1: Create nodes
    result.emailNodes = await this.syncEmailNodes(graph);
    result.threadNodes = await this.syncThreadNodes(graph);
    result.calendarNodes = await this.syncCalendarNodes(graph);

    // Phase 2: Direct relationships
    result.sentRels = await this.createSentRels(graph);
    result.receivedRels = await this.createReceivedRels(graph);
    result.partOfRels = await this.createPartOfRels(graph);
    result.organizedRels = await this.createOrganizedRels(graph);
    result.attendsRels = await this.createAttendsRels(graph);

    // Phase 3: Derived relationships
    result.emailedRels = await this.createEmailedRels(graph);
    result.metWithRels = await this.createMetWithRels(graph);

    log.info(`Graph sync complete: ${result.emailNodes} emails, ${result.threadNodes} threads, ${result.calendarNodes} cal events, ${result.sentRels} SENT, ${result.receivedRels} RECEIVED, ${result.emailedRels} EMAILED, ${result.metWithRels} MET_WITH`);
    return result;
  }

  // ── Node sync ───────────────────────────────────

  private async syncEmailNodes(graph: GraphDriver): Promise<number> {
    const emails = this.db.prepare(
      `SELECT gmail_id, subject, from_email, from_name, date, snippet, thread_id, has_attachments
       FROM google_emails`,
    ).all() as Array<{
      gmail_id: string; subject: string; from_email: string; from_name: string;
      date: string; snippet: string; thread_id: string; has_attachments: number;
    }>;

    let created = 0;
    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const batch = emails.slice(i, i + BATCH_SIZE);
      const res = await graph.run(
        `UNWIND $batch AS e
         MERGE (n:Email {gmail_id: e.gmail_id})
         SET n.subject = e.subject,
             n.from_email = e.from_email,
             n.from_name = e.from_name,
             n.date = e.date,
             n.snippet = e.snippet,
             n.thread_id = e.thread_id,
             n.has_attachments = e.has_attachments,
             n.module = 'google-sync'
         RETURN count(n) AS cnt`,
        { batch },
      );
      created += getCount(res, "cnt");
    }
    return created;
  }

  private async syncThreadNodes(graph: GraphDriver): Promise<number> {
    const threads = this.db.prepare(
      `SELECT gmail_thread_id, subject, message_count, last_message_date
       FROM google_email_threads`,
    ).all() as Array<{
      gmail_thread_id: string; subject: string; message_count: number; last_message_date: string;
    }>;

    let created = 0;
    for (let i = 0; i < threads.length; i += BATCH_SIZE) {
      const batch = threads.slice(i, i + BATCH_SIZE);
      const res = await graph.run(
        `UNWIND $batch AS t
         MERGE (n:EmailThread {gmail_thread_id: t.gmail_thread_id})
         SET n.subject = t.subject,
             n.message_count = t.message_count,
             n.last_message_date = t.last_message_date,
             n.module = 'google-sync'
         RETURN count(n) AS cnt`,
        { batch },
      );
      created += getCount(res, "cnt");
    }
    return created;
  }

  private async syncCalendarNodes(graph: GraphDriver): Promise<number> {
    const events = this.db.prepare(
      `SELECT google_event_id, title, start_at, end_at, location,
              organizer_email, status, all_day
       FROM google_calendar_events`,
    ).all() as Array<{
      google_event_id: string; title: string; start_at: string; end_at: string;
      location: string; organizer_email: string; status: string; all_day: number;
    }>;

    let created = 0;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      const res = await graph.run(
        `UNWIND $batch AS e
         MERGE (n:CalendarEvent {google_event_id: e.google_event_id})
         SET n.title = e.title,
             n.start_at = e.start_at,
             n.end_at = e.end_at,
             n.location = e.location,
             n.organizer_email = e.organizer_email,
             n.status = e.status,
             n.all_day = e.all_day,
             n.module = 'google-sync'
         RETURN count(n) AS cnt`,
        { batch },
      );
      created += getCount(res, "cnt");
    }
    return created;
  }

  // ── Direct relationships ────────────────────────

  private async createSentRels(graph: GraphDriver): Promise<number> {
    const res = await graph.run(
      `MATCH (e:Email)
       WHERE e.module = 'google-sync' AND e.from_email IS NOT NULL AND e.from_email <> ''
       MATCH (p:Person)
       WHERE p.relationship IS NOT NULL AND toLower(p.email) = toLower(e.from_email)
       MERGE (p)-[:SENT]->(e)
       RETURN count(*) AS cnt`,
    );
    return getCount(res, "cnt");
  }

  private async createReceivedRels(graph: GraphDriver): Promise<number> {
    const emails = this.db.prepare(
      `SELECT gmail_id, to_emails, cc_emails FROM google_emails
       WHERE to_emails <> '' OR cc_emails <> ''`,
    ).all() as Array<{ gmail_id: string; to_emails: string; cc_emails: string }>;

    let totalRels = 0;
    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const batch = emails.slice(i, i + BATCH_SIZE);
      const rows = batch.map((e) => {
        const toList: Array<{ email: string }> = tryParseJson(e.to_emails, []);
        const ccList: Array<{ email: string }> = tryParseJson(e.cc_emails, []);
        const allRecipients = [...toList, ...ccList]
          .map((r) => r.email?.toLowerCase())
          .filter(Boolean);
        return { gmail_id: e.gmail_id, recipients: allRecipients };
      });

      const res = await graph.run(
        `UNWIND $rows AS row
         MATCH (e:Email {gmail_id: row.gmail_id})
         WHERE e.module = 'google-sync'
         UNWIND row.recipients AS recipientEmail
         MATCH (p:Person)
         WHERE p.relationship IS NOT NULL AND toLower(p.email) = recipientEmail
         MERGE (p)-[:RECEIVED]->(e)
         RETURN count(*) AS cnt`,
        { rows },
      );
      totalRels += getCount(res, "cnt");
    }
    return totalRels;
  }

  private async createPartOfRels(graph: GraphDriver): Promise<number> {
    const res = await graph.run(
      `MATCH (e:Email)
       WHERE e.module = 'google-sync' AND e.thread_id IS NOT NULL AND e.thread_id <> ''
       MATCH (t:EmailThread {gmail_thread_id: e.thread_id})
       WHERE t.module = 'google-sync'
       MERGE (e)-[:PART_OF]->(t)
       RETURN count(*) AS cnt`,
    );
    return getCount(res, "cnt");
  }

  private async createOrganizedRels(graph: GraphDriver): Promise<number> {
    const res = await graph.run(
      `MATCH (ce:CalendarEvent)
       WHERE ce.module = 'google-sync' AND ce.organizer_email IS NOT NULL AND ce.organizer_email <> ''
       MATCH (p:Person)
       WHERE p.relationship IS NOT NULL AND toLower(p.email) = toLower(ce.organizer_email)
       MERGE (p)-[:ORGANIZED]->(ce)
       RETURN count(*) AS cnt`,
    );
    return getCount(res, "cnt");
  }

  private async createAttendsRels(graph: GraphDriver): Promise<number> {
    const events = this.db.prepare(
      `SELECT google_event_id, attendees FROM google_calendar_events
       WHERE attendees <> '' AND attendees <> '[]'`,
    ).all() as Array<{ google_event_id: string; attendees: string }>;

    let totalRels = 0;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      const rows = batch.map((e) => {
        const attendees: Array<{ email: string; responseStatus: string }> = tryParseJson(e.attendees, []);
        return {
          google_event_id: e.google_event_id,
          attendees: attendees
            .filter((a) => a.email)
            .map((a) => ({ email: a.email.toLowerCase(), response: a.responseStatus })),
        };
      });

      const res = await graph.run(
        `UNWIND $rows AS row
         MATCH (ce:CalendarEvent {google_event_id: row.google_event_id})
         WHERE ce.module = 'google-sync'
         UNWIND row.attendees AS att
         MATCH (p:Person)
         WHERE p.relationship IS NOT NULL AND toLower(p.email) = att.email
         MERGE (p)-[r:ATTENDS]->(ce)
         SET r.response = att.response
         RETURN count(*) AS cnt`,
        { rows },
      );
      totalRels += getCount(res, "cnt");
    }
    return totalRels;
  }

  // ── Derived relationships ───────────────────────

  private async createEmailedRels(graph: GraphDriver): Promise<number> {
    const res = await graph.run(
      `MATCH (a:Person)-[:SENT]->(e:Email)<-[:RECEIVED]-(b:Person)
       WHERE e.module = 'google-sync'
         AND a.relationship IS NOT NULL
         AND b.relationship IS NOT NULL
         AND a <> b
       WITH a, b, count(e) AS cnt, max(e.date) AS lastDate
       MERGE (a)-[r:EMAILED]->(b)
       SET r.count = cnt, r.last_date = lastDate
       RETURN count(r) AS total`,
    );
    return getCount(res, "total");
  }

  private async createMetWithRels(graph: GraphDriver): Promise<number> {
    const res = await graph.run(
      `MATCH (a:Person)-[:ATTENDS]->(ce:CalendarEvent)<-[:ATTENDS]-(b:Person)
       WHERE ce.module = 'google-sync'
         AND a.relationship IS NOT NULL
         AND b.relationship IS NOT NULL
         AND a <> b
       WITH a, b, count(ce) AS cnt, max(ce.start_at) AS lastDate
       MERGE (a)-[r:MET_WITH]->(b)
       SET r.count = cnt, r.last_date = lastDate
       RETURN count(r) AS total`,
    );
    return getCount(res, "total");
  }
}

function tryParseJson<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Event Notifier Skill — Enhanced
 * Format notifications, pending RSVP reminders, attendance tracking
 */

export default function createSkill() {
  let _db = null;

  const metadata = {
    id: "event-notifier",
    name: "Event Notifier",
    description: "Format event notifications, track pending RSVPs, and generate attendance reports",
    version: "2.0.0",
    author: "Kernl",
    icon: "📣",
    category: "events",
    permissions: ["read:events", "read:contacts", "notifications"],
    tags: ["events", "notifications", "sharing", "rsvp"],
  };

  function safeQuery(sql, ...params) {
    try { return _db.prepare(sql).all(...params); } catch { return []; }
  }

  function fmtDate(iso) {
    if (!iso) return "TBD";
    return new Date(iso).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  function fmtCost(cents, currency) {
    if (!cents || cents === 0) return "Free";
    return `${(cents / 100).toFixed(2)} ${currency || "EUR"}`;
  }

  function buildMessage(event, attendees, channel) {
    const lines = [];
    lines.push(`📣 *${event.title}*`);
    if (event.description) lines.push(`\n${event.description}`);
    lines.push("");
    lines.push(`📅 ${fmtDate(event.start_at)}`);
    if (event.duration_minutes) lines.push(`⏱ ${event.duration_minutes} min`);
    if (event.location) lines.push(`📍 ${event.location}`);
    if (event.location_url) lines.push(`🔗 ${event.location_url}`);
    lines.push(`💰 ${fmtCost(event.cost_per_person_cents, event.cost_currency)} per person`);

    if (event.max_attendees) {
      const yesCount = attendees.filter(a => a.rsvp_status === "yes").length;
      lines.push(`👥 ${yesCount}/${event.max_attendees} spots filled`);
    }

    lines.push("");
    if (channel === "whatsapp") lines.push("Reply *YES*, *NO* or *MAYBE* to RSVP");
    else if (channel === "telegram") lines.push("Reply with your RSVP: YES / NO / MAYBE");
    else lines.push("Please confirm your attendance.");

    return lines.join("\n");
  }

  const tools = [
    {
      name: "event_notify_upcoming",
      description: "Format notification messages for upcoming events, ready to send via Telegram/WhatsApp/Mattermost",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "number", description: "Days ahead (default: 7)" },
          channel: { type: "string", enum: ["telegram", "whatsapp", "mattermost"] },
          event_id: { type: "string", description: "Specific event ID (overrides days)" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        try {
          const channel = args.channel ?? "telegram";
          const days = args.days ?? 7;
          const cutoff = new Date(Date.now() + days * 86400000).toISOString();
          const now = new Date().toISOString();

          let events;
          if (args.event_id) {
            const ev = _db.prepare("SELECT * FROM events WHERE id = ?").get(args.event_id);
            events = ev ? [ev] : [];
          } else {
            events = safeQuery(
              "SELECT * FROM events WHERE start_at >= ? AND start_at <= ? AND status IN ('open','confirmed') ORDER BY start_at ASC LIMIT 10",
              now, cutoff,
            );
          }

          if (events.length === 0) {
            return { content: [{ type: "text", text: `No upcoming events in the next ${days} days.` }] };
          }

          const output = [];
          for (const ev of events) {
            const attendees = safeQuery("SELECT * FROM event_attendees WHERE event_id = ?", ev.id);
            output.push(`--- ${ev.title} ---\n${buildMessage(ev, attendees, channel)}`);
          }

          return { content: [{ type: "text", text: output.join("\n\n") }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    },
    {
      name: "event_notify_summary",
      description: "Generate post-event attendance summary to share with the group",
      inputSchema: {
        type: "object",
        required: ["event_id"],
        properties: {
          event_id: { type: "string", description: "Event ID" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        if (!args.event_id) return { content: [{ type: "text", text: "event_id required" }] };
        try {
          const ev = _db.prepare("SELECT * FROM events WHERE id = ?").get(args.event_id);
          if (!ev) return { content: [{ type: "text", text: "Event not found" }] };

          const attendees = safeQuery("SELECT * FROM event_attendees WHERE event_id = ?", ev.id);
          const yes = attendees.filter(a => a.rsvp_status === "yes");
          const no = attendees.filter(a => a.rsvp_status === "no");
          const maybe = attendees.filter(a => a.rsvp_status === "maybe");
          const pending = attendees.filter(a => a.rsvp_status === "pending");
          const waitlist = attendees.filter(a => a.rsvp_status === "waitlist");

          const totalCost = yes.length * (ev.cost_per_person_cents ?? 0);
          const lines = [
            `📊 *${ev.title} — Attendance Summary*`,
            `📅 ${fmtDate(ev.start_at)}`,
            "",
            `✅ Confirmed: ${yes.length}`,
            yes.length > 0 ? yes.map(a => `  • ${a.name || a.phone}`).join("\n") : "",
            no.length > 0 ? `❌ Declined: ${no.length}` : "",
            maybe.length > 0 ? `🤔 Maybe: ${maybe.length}` : "",
            pending.length > 0 ? `⏳ Pending: ${pending.length}` : "",
            waitlist.length > 0 ? `📋 Waitlist: ${waitlist.length}` : "",
            "",
            totalCost > 0 ? `💰 Total: ${(totalCost / 100).toFixed(2)} ${ev.cost_currency || "EUR"}` : "",
          ].filter(l => l !== "");

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    },
    {
      name: "event_pending_rsvps",
      description: "List all upcoming events with pending RSVPs — people who haven't responded yet",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "number", description: "Days ahead to check (default: 14)" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        try {
          const days = args.days ?? 14;
          const cutoff = new Date(Date.now() + days * 86400000).toISOString();
          const now = new Date().toISOString();

          const events = safeQuery(
            "SELECT * FROM events WHERE start_at >= ? AND start_at <= ? AND status IN ('open','confirmed') ORDER BY start_at ASC",
            now, cutoff,
          );

          const results = [];
          for (const ev of events) {
            const pending = safeQuery(
              "SELECT * FROM event_attendees WHERE event_id = ? AND rsvp_status = 'pending'",
              ev.id,
            );
            if (pending.length > 0) {
              results.push({ event: ev, pending });
            }
          }

          if (results.length === 0) {
            return { content: [{ type: "text", text: "No pending RSVPs for upcoming events. Everyone has responded!" }] };
          }

          const lines = [`# ⏳ Pending RSVPs\n`];
          for (const { event, pending } of results) {
            lines.push(`## ${event.title} — ${fmtDate(event.start_at)}`);
            lines.push(`${pending.length} pending response${pending.length > 1 ? "s" : ""}:`);
            pending.forEach(p => {
              lines.push(`  • ${p.name || p.phone || "Unknown"}`);
            });
            lines.push("");
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    },
    {
      name: "event_attendance_report",
      description: "Generate an attendance reliability report for frequent event participants",
      inputSchema: {
        type: "object",
        properties: {
          min_events: { type: "number", description: "Min events invited to (default: 3)" },
          limit: { type: "number", description: "Max people (default: 15)" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        try {
          const minEvents = args.min_events ?? 3;
          const limit = args.limit ?? 15;

          const rows = safeQuery(
            `SELECT
               COALESCE(a.name, c.name, a.phone) as display_name,
               COUNT(*) as invited,
               SUM(CASE WHEN a.rsvp_status = 'yes' THEN 1 ELSE 0 END) as attended,
               SUM(CASE WHEN a.rsvp_status = 'no' THEN 1 ELSE 0 END) as declined,
               SUM(CASE WHEN a.rsvp_status = 'pending' THEN 1 ELSE 0 END) as no_response
             FROM event_attendees a
             LEFT JOIN contacts c ON a.contact_id = c.id
             GROUP BY COALESCE(a.contact_id, a.phone)
             HAVING invited >= ?
             ORDER BY CAST(attended AS REAL) / invited DESC
             LIMIT ?`,
            minEvents, limit,
          );

          if (rows.length === 0) {
            return { content: [{ type: "text", text: `No attendees with ${minEvents}+ event invitations found.` }] };
          }

          const lines = ["# 📊 Attendance Reliability Report\n"];
          lines.push("| Person | Events | Attended | Rate |");
          lines.push("|--------|--------|----------|------|");
          rows.forEach(r => {
            const rate = Math.round((r.attended / r.invited) * 100);
            const emoji = rate >= 80 ? "🟢" : rate >= 50 ? "🟡" : "🔴";
            lines.push(`| ${emoji} ${r.display_name} | ${r.invited} | ${r.attended} | ${rate}% |`);
          });

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    },
  ];

  return {
    metadata,
    tools,
    async initialize(ctx, _config) { _db = ctx.sqlite; },
    async shutdown() { _db = null; },
  };
}

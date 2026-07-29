/**
 * Stale Contacts Monitor Skill — Enhanced
 * Relationship health scoring, event co-attendance, suggested actions
 */

export default function createSkill() {
  let _db = null;

  const metadata = {
    id: "stale-contacts",
    name: "Stale Contacts Monitor",
    description: "Surfaces contacts you haven't interacted with recently, with relationship health scores",
    version: "2.0.0",
    author: "Kernl",
    icon: "👤",
    category: "productivity",
    permissions: ["read:contacts", "notifications"],
    tags: ["crm", "contacts", "follow-up", "health-score"],
  };

  function safeQuery(sql, ...params) {
    try { return _db.prepare(sql).all(...params); } catch { return []; }
  }

  function safeGet(sql, ...params) {
    try { return _db.prepare(sql).get(...params); } catch { return null; }
  }

  function healthScore(contact) {
    let score = 100;
    const daysSince = contact.days_since_interaction ?? 999;

    // Decay based on time
    if (daysSince > 365) score -= 60;
    else if (daysSince > 180) score -= 40;
    else if (daysSince > 90) score -= 25;
    else if (daysSince > 60) score -= 15;
    else if (daysSince > 30) score -= 5;

    // Bonus for frequent interactions
    const intCount = contact.interaction_count ?? 0;
    if (intCount >= 10) score += 10;
    else if (intCount >= 5) score += 5;

    // Penalty for no contact info
    if (!contact.email && !contact.phone) score -= 10;

    // Relationship weight
    if (contact.relationship === "family") score += 5;
    else if (contact.relationship === "personal") score += 3;

    return Math.max(0, Math.min(100, score));
  }

  function healthEmoji(score) {
    if (score >= 80) return "🟢";
    if (score >= 60) return "🟡";
    if (score >= 40) return "🟠";
    return "🔴";
  }

  const tools = [
    {
      name: "stale_find",
      description: "Find contacts you haven't interacted with recently, ranked by relationship health score",
      inputSchema: {
        type: "object",
        properties: {
          stale_days: { type: "number", description: "Days without interaction to be considered stale (default: 60)" },
          relationship: { type: "string", enum: ["personal", "professional", "family", "acquaintance"] },
          limit: { type: "number", description: "Max results (default: 10)" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        const days = args.stale_days ?? 60;
        const limit = args.limit ?? 10;
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

        try {
          let sql = `
            SELECT c.*,
              (SELECT MAX(date) FROM interactions WHERE contact_id = c.id) as last_int_date,
              (SELECT COUNT(*) FROM interactions WHERE contact_id = c.id) as interaction_count,
              CAST(JULIANDAY('now') - JULIANDAY(COALESCE(c.last_interaction, c.created_at)) AS INTEGER) as days_since_interaction
            FROM contacts c
            WHERE (c.last_interaction IS NULL OR c.last_interaction < ?)
          `;
          const params = [cutoff];

          if (args.relationship) {
            sql += " AND c.relationship = ?";
            params.push(args.relationship);
          }

          sql += ` ORDER BY
            CASE c.relationship
              WHEN 'family' THEN 0 WHEN 'personal' THEN 1 WHEN 'professional' THEN 2 ELSE 3
            END,
            c.last_interaction ASC NULLS FIRST
            LIMIT ?`;
          params.push(limit);

          const contacts = _db.prepare(sql).all(...params);

          if (contacts.length === 0) {
            return { content: [{ type: "text", text: `No stale contacts found (threshold: ${days} days). Great job staying in touch!` }] };
          }

          const lines = [`# 👤 Stale Contacts — Not contacted in ${days}+ days\n`];
          contacts.forEach((c, i) => {
            const score = healthScore(c);
            const emoji = healthEmoji(score);
            const lastContact = c.last_interaction ? `Last: ${c.last_interaction}` : "Never contacted";
            const company = c.company ? ` @ ${c.company}` : "";

            lines.push(`${i + 1}. ${emoji} **${c.name}**${company} (${c.relationship}) — Health: ${score}%`);
            lines.push(`   📧 ${c.email || "no email"} · ${lastContact} · ${c.interaction_count} interactions`);

            // Suggested action
            if (score < 40) lines.push(`   💡 _Urgent: schedule a catch-up call or meeting_`);
            else if (score < 60) lines.push(`   💡 _Send a quick check-in message_`);

            if (c.notes) lines.push(`   _${c.notes.slice(0, 80)}_`);
          });

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    },
    {
      name: "stale_stats",
      description: "Get statistics about contact interaction freshness and overall relationship health",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        try {
          const today = new Date().toISOString().split("T")[0];
          const stats = {
            total: safeGet("SELECT COUNT(*) as n FROM contacts")?.n ?? 0,
            never: safeGet("SELECT COUNT(*) as n FROM contacts WHERE last_interaction IS NULL")?.n ?? 0,
            fresh30: safeGet(`SELECT COUNT(*) as n FROM contacts WHERE last_interaction >= date(?, '-30 days')`, today)?.n ?? 0,
            stale60: safeGet(`SELECT COUNT(*) as n FROM contacts WHERE last_interaction IS NULL OR last_interaction < date(?, '-60 days')`, today)?.n ?? 0,
            stale90: safeGet(`SELECT COUNT(*) as n FROM contacts WHERE last_interaction IS NULL OR last_interaction < date(?, '-90 days')`, today)?.n ?? 0,
          };

          // Relationship distribution
          const byRel = safeQuery(
            "SELECT relationship, COUNT(*) as n FROM contacts GROUP BY relationship ORDER BY n DESC"
          );

          const lines = [
            "# 📊 Contact Health Dashboard",
            "",
            `**Total contacts:** ${stats.total}`,
            `🟢 Active (last 30d): **${stats.fresh30}** (${stats.total ? Math.round(stats.fresh30 / stats.total * 100) : 0}%)`,
            `🟡 Stale (60d+): **${stats.stale60}** (${stats.total ? Math.round(stats.stale60 / stats.total * 100) : 0}%)`,
            `🔴 Very stale (90d+): **${stats.stale90}** (${stats.total ? Math.round(stats.stale90 / stats.total * 100) : 0}%)`,
            `⚪ Never contacted: **${stats.never}**`,
          ];

          if (byRel.length > 0) {
            lines.push("\n**By relationship:**");
            byRel.forEach(r => {
              const bar = "█".repeat(Math.min(20, Math.round(r.n / Math.max(1, stats.total) * 40)));
              lines.push(`  ${r.relationship}: ${bar} ${r.n}`);
            });
          }

          // Overall health score
          const activePercent = stats.total ? Math.round(stats.fresh30 / stats.total * 100) : 0;
          const overallHealth = activePercent >= 30 ? "🟢 Healthy" : activePercent >= 15 ? "🟡 Needs attention" : "🔴 Critical";
          lines.push(`\n**Overall network health:** ${overallHealth} (${activePercent}% active)`);

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    },
    {
      name: "stale_at_risk",
      description: "Find contacts about to become stale (approaching the stale threshold) — proactive prevention",
      inputSchema: {
        type: "object",
        properties: {
          days_threshold: { type: "number", description: "Stale threshold in days (default: 60)" },
          warning_window: { type: "number", description: "Days before threshold to warn (default: 14)" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        const threshold = args.days_threshold ?? 60;
        const window = args.warning_window ?? 14;
        const today = new Date().toISOString().split("T")[0];
        try {
          const warningDate = new Date(Date.now() - (threshold - window) * 86400000).toISOString().split("T")[0];
          const staleDate = new Date(Date.now() - threshold * 86400000).toISOString().split("T")[0];

          const contacts = safeQuery(
            `SELECT c.*, CAST(JULIANDAY('now') - JULIANDAY(c.last_interaction) AS INTEGER) as days_since
             FROM contacts c
             WHERE c.last_interaction IS NOT NULL
               AND c.last_interaction < ?
               AND c.last_interaction >= ?
               AND c.relationship IN ('personal', 'professional', 'family')
             ORDER BY c.last_interaction ASC LIMIT 10`,
            warningDate, staleDate,
          );

          if (contacts.length === 0) {
            return { content: [{ type: "text", text: `No contacts approaching the ${threshold}-day stale threshold. All good!` }] };
          }

          const lines = [`# ⚠️ At-Risk Contacts — ${window}d window before ${threshold}d stale\n`];
          contacts.forEach((c, i) => {
            const daysLeft = threshold - (c.days_since ?? 0);
            lines.push(`${i + 1}. **${c.name}** (${c.relationship}) — ${c.days_since}d ago, **${daysLeft}d left**`);
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

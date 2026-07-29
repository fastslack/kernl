/**
 * Water Tracker Skill — Enhanced
 * Track intake, weekly trends, streaks, and log water
 */

export default function createSkill() {
  let _db = null;

  const metadata = {
    id: "water-tracker",
    name: "Water Tracker",
    description: "Track water intake with daily goals, weekly trends, and streak tracking",
    version: "2.0.0",
    author: "Kernl",
    icon: "💧",
    category: "health",
    permissions: ["read:reminders", "write:reminders", "read:health", "notifications"],
    tags: ["health", "habits", "reminders", "water"],
  };

  function safeGet(sql, ...params) {
    try { return _db.prepare(sql).get(...params); } catch { return null; }
  }

  function safeQuery(sql, ...params) {
    try { return _db.prepare(sql).all(...params); } catch { return []; }
  }

  const tools = [
    {
      name: "water_status",
      description: "Get today's water intake status and progress toward your daily goal",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "number", description: "Daily glass goal (default: 8)" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        const goal = args.goal ?? 8;
        const today = new Date().toISOString().split("T")[0];
        try {
          const row = safeGet("SELECT COUNT(*) as n FROM life_log WHERE type='water' AND date=?", today);
          const count = row?.n ?? 0;
          const pct = Math.min(100, Math.round(count / goal * 100));
          const bar = "💧".repeat(Math.min(count, goal)) + "○".repeat(Math.max(0, goal - count));
          const lines = [
            `# 💧 Water Intake — ${today}`,
            `${bar}`,
            `**${count}/${goal} glasses** (${pct}%)`,
            count >= goal ? "\n✅ Daily goal reached!" : `\n${goal - count} more glasses to go`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    },
    {
      name: "water_log",
      description: "Log a glass of water (or more) for today",
      inputSchema: {
        type: "object",
        properties: {
          glasses: { type: "number", description: "Number of glasses to log (default: 1)" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        const glasses = Math.max(1, Math.min(10, args.glasses ?? 1));
        const today = new Date().toISOString().split("T")[0];
        const now = new Date().toISOString();
        try {
          const insertSql = `INSERT INTO life_log (id, type, value, date, created_at) VALUES (?, 'water', '1', ?, ?)`;
          for (let i = 0; i < glasses; i++) {
            const id = crypto.randomUUID?.() ?? `w-${Date.now()}-${i}`;
            _db.prepare(insertSql).run(id, today, now);
          }
          const total = safeGet("SELECT COUNT(*) as n FROM life_log WHERE type='water' AND date=?", today);
          return { content: [{ type: "text", text: `💧 +${glasses} glass${glasses > 1 ? "es" : ""} logged. Total today: **${total?.n ?? glasses}/8**` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    },
    {
      name: "water_weekly",
      description: "Show water intake for the past 7 days with trends and streak",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "number", description: "Daily glass goal (default: 8)" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        const goal = args.goal ?? 8;
        try {
          const rows = safeQuery(
            `SELECT date, COUNT(*) as n FROM life_log
             WHERE type = 'water' AND date >= date('now', '-7 days')
             GROUP BY date ORDER BY date ASC`,
          );

          const lines = ["# 💧 Water — Last 7 Days\n"];

          // Build day map
          const dayMap = new Map(rows.map(r => [r.date, r.n]));
          let streak = 0;
          let checkStreak = true;

          for (let i = 0; i < 7; i++) {
            const d = new Date(Date.now() - (6 - i) * 86400000).toISOString().split("T")[0];
            const count = dayMap.get(d) ?? 0;
            const bar = "█".repeat(Math.min(count, 12)) + "░".repeat(Math.max(0, Math.min(goal, 12) - Math.min(count, 12)));
            const met = count >= goal ? "✅" : "  ";
            const dayLabel = new Date(d).toLocaleDateString("en", { weekday: "short" });
            lines.push(`${dayLabel} ${bar} ${count}/${goal} ${met}`);
          }

          // Compute streak (consecutive days meeting goal, counting backward from today)
          for (let i = 0; i < 30; i++) {
            const d = new Date(Date.now() - i * 86400000).toISOString().split("T")[0];
            const row = safeGet("SELECT COUNT(*) as n FROM life_log WHERE type='water' AND date=?", d);
            if ((row?.n ?? 0) >= goal) {
              streak++;
            } else {
              break;
            }
          }

          const totalWeek = rows.reduce((s, r) => s + r.n, 0);
          const avgWeek = rows.length > 0 ? (totalWeek / 7).toFixed(1) : "0";

          lines.push("");
          lines.push(`**Weekly avg:** ${avgWeek} glasses/day`);
          lines.push(`**Current streak:** ${streak} day${streak !== 1 ? "s" : ""} meeting goal`);

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

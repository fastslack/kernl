/**
 * Morning Briefing Skill — Enhanced
 * Cross-module daily briefing: tasks, reminders, events, habits, learning, training
 */

export default function createSkill() {
  let _db = null;

  const metadata = {
    id: "morning-briefing",
    name: "Morning Briefing",
    description: "Generates a personalized daily briefing every morning",
    version: "2.0.0",
    author: "Kernl",
    icon: "☀️",
    category: "productivity",
    permissions: ["read:tasks", "read:reminders", "read:events", "read:health", "notifications"],
    tags: ["automation", "daily", "briefing"],
  };

  function safeQuery(sql, ...params) {
    try { return _db.prepare(sql).all(...params); } catch { return []; }
  }

  function safeGet(sql, ...params) {
    try { return _db.prepare(sql).get(...params); } catch { return null; }
  }

  const tools = [
    {
      name: "briefing_generate",
      description: "Generate a morning briefing with tasks, reminders, events, habits, learning progress, and training summary",
      inputSchema: {
        type: "object",
        properties: {
          include_overdue: { type: "boolean", description: "Include overdue tasks" },
          max_tasks: { type: "number", description: "Max tasks (default: 5)" },
          include_learning: { type: "boolean", description: "Include learning/training (default: true)" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        const maxTasks = args.max_tasks ?? 5;
        const includeLearning = args.include_learning !== false;
        const today = new Date().toISOString().split("T")[0];
        const dayName = new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

        try {
          const lines = [`# ☀️ Morning Briefing — ${dayName}\n`];

          // KPIs
          const taskCount = safeGet("SELECT COUNT(*) as n FROM tasks WHERE status IN ('todo','in_progress')");
          const overdueCount = safeGet(`SELECT COUNT(*) as n FROM tasks WHERE status NOT IN ('done','blocked') AND due_date < ?`, today);
          const reminderCount = safeGet(`SELECT COUNT(*) as n FROM reminders WHERE status = 'active' AND trigger_at <= datetime(?, '+1 day')`, today + "T23:59:59Z");
          lines.push(`📋 **${taskCount?.n ?? 0}** open tasks · ⚠️ **${overdueCount?.n ?? 0}** overdue · 🔔 **${reminderCount?.n ?? 0}** reminders today\n`);

          // Top tasks
          const tasks = safeQuery(
            `SELECT * FROM tasks WHERE status NOT IN ('done','blocked')
             AND (due_date <= ? OR due_date IS NULL)
             ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
             LIMIT ?`,
            today, maxTasks,
          );
          if (tasks.length > 0) {
            lines.push("## 📋 Priority Tasks");
            tasks.forEach((t) => {
              const due = t.due_date ? ` (due: ${t.due_date})` : "";
              const pri = t.priority === "urgent" ? "🔴" : t.priority === "high" ? "🟠" : t.priority === "medium" ? "🔵" : "⚪";
              lines.push(`${pri} **${t.title}**${due}`);
            });
            lines.push("");
          }

          // Reminders
          const reminders = safeQuery(
            `SELECT * FROM reminders WHERE status = 'active'
             AND trigger_at <= datetime(?, '+1 day')
             ORDER BY trigger_at ASC LIMIT 5`,
            today + "T23:59:59Z",
          );
          if (reminders.length > 0) {
            lines.push("## 🔔 Reminders");
            reminders.forEach((r) => {
              const at = new Date(r.trigger_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
              lines.push(`- **${r.title}** at ${at}`);
            });
            lines.push("");
          }

          // Events today
          const events = safeQuery(
            `SELECT * FROM events WHERE date(start_at) = ? AND status IN ('open','confirmed')
             ORDER BY start_at ASC LIMIT 5`,
            today,
          );
          if (events.length > 0) {
            lines.push("## 📅 Today's Events");
            events.forEach((e) => {
              const at = new Date(e.start_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
              const loc = e.location ? ` 📍 ${e.location}` : "";
              lines.push(`- **${e.title}** at ${at}${loc}`);
            });
            lines.push("");
          }

          // Habits & Water
          const waterCount = safeGet("SELECT COUNT(*) as n FROM life_log WHERE type='water' AND date=?", today);
          const habitsToday = safeQuery("SELECT DISTINCT value FROM life_log WHERE type='habit' AND date=?", today);
          if ((waterCount?.n ?? 0) > 0 || habitsToday.length > 0) {
            lines.push("## 🎯 Today So Far");
            if (waterCount?.n) lines.push(`💧 Water: ${waterCount.n}/8 glasses`);
            if (habitsToday.length > 0) lines.push(`✅ Habits: ${habitsToday.map(h => h.value).join(", ")}`);
            lines.push("");
          }

          // Learning & Training (cross-module)
          if (includeLearning) {
            // Due flashcards
            const dueCards = safeGet(
              `SELECT COUNT(*) as n FROM learning_flashcards WHERE next_review <= ?`,
              today,
            );
            // Currently reading
            const reading = safeQuery(
              `SELECT title, current_page, total_pages FROM learning_resources WHERE status = 'in_progress' LIMIT 3`,
            );
            // Recent workouts
            const lastWorkout = safeGet(
              `SELECT name, date, duration_minutes FROM training_workouts ORDER BY date DESC LIMIT 1`,
            );

            if ((dueCards?.n ?? 0) > 0 || reading.length > 0 || lastWorkout) {
              lines.push("## 📚 Learning & Training");
              if (dueCards?.n > 0) lines.push(`🧠 **${dueCards.n}** flashcards due for review`);
              reading.forEach(r => {
                const pct = r.total_pages ? ` (${Math.round(r.current_page / r.total_pages * 100)}%)` : "";
                lines.push(`📖 Reading: **${r.title}**${pct}`);
              });
              if (lastWorkout) {
                lines.push(`🏋️ Last workout: ${lastWorkout.name} on ${lastWorkout.date} (${lastWorkout.duration_minutes}min)`);
              }
              lines.push("");
            }
          }

          // Overdue maintenance
          const overdue_maint = safeGet(
            `SELECT COUNT(*) as n FROM home_maintenance_items WHERE next_due < ?`,
            today,
          );
          if (overdue_maint?.n > 0) {
            lines.push(`🏠 **${overdue_maint.n}** overdue home maintenance items\n`);
          }

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

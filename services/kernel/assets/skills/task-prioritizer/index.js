/**
 * Task Prioritizer Skill — Enhanced
 * Context-aware prioritization, focus suggestions, and productivity score
 */

export default function createSkill() {
  let _db = null;

  const metadata = {
    id: "task-prioritizer",
    name: "Task Prioritizer",
    description: "Analyzes backlog and re-prioritizes tasks based on deadlines, context, and workload",
    version: "2.0.0",
    author: "Kernl",
    icon: "⚡",
    category: "productivity",
    permissions: ["read:tasks", "write:tasks", "notifications"],
    tags: ["tasks", "gtd", "priority", "focus"],
  };

  function safeQuery(sql, ...params) {
    try { return _db.prepare(sql).all(...params); } catch { return []; }
  }

  function safeGet(sql, ...params) {
    try { return _db.prepare(sql).get(...params); } catch { return null; }
  }

  const tools = [
    {
      name: "prioritizer_analyze",
      description: "Analyze task backlog and get priority recommendations based on due dates, status, and context",
      inputSchema: {
        type: "object",
        properties: {
          apply: { type: "boolean", description: "If true, apply changes (default: false = dry run)" },
          context: { type: "string", description: "Filter GTD context (e.g. @home, @work)" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        const apply = args.apply === true;
        const today = new Date().toISOString().split("T")[0];
        const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
        const week = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];

        try {
          let sql = "SELECT * FROM tasks WHERE status NOT IN ('done', 'blocked')";
          const params = [];
          if (args.context) { sql += " AND context = ?"; params.push(args.context); }

          const tasks = _db.prepare(sql).all(...params);
          const changes = [];

          for (const task of tasks) {
            let suggestedPriority = task.priority;

            if (task.due_date) {
              if (task.due_date < today) suggestedPriority = "urgent";
              else if (task.due_date <= tomorrow) {
                if (task.priority === "low" || task.priority === "medium") suggestedPriority = "high";
              } else if (task.due_date <= week) {
                if (task.priority === "low") suggestedPriority = "medium";
              }
            }

            if (suggestedPriority !== task.priority) {
              changes.push({ task, from: task.priority, to: suggestedPriority });
            }
          }

          if (changes.length === 0) {
            return { content: [{ type: "text", text: `✅ All ${tasks.length} tasks have appropriate priorities.` }] };
          }

          if (apply) {
            const now = new Date().toISOString();
            for (const { task, to } of changes) {
              _db.prepare("UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?").run(to, now, task.id);
            }
          }

          const lines = [
            apply ? `# ⚡ Priorities Updated — ${changes.length} tasks` : `# ⚡ Priority Recommendations — ${changes.length} suggestions`,
            apply ? "" : "_Run with `apply: true` to apply_",
            "",
          ];

          for (const level of [["urgent", "🔴"], ["high", "🟠"], ["medium", "🔵"]]) {
            const group = changes.filter(c => c.to === level[0]);
            if (group.length > 0) {
              lines.push(`## ${level[1]} Upgrade to ${level[0]}`);
              group.forEach(({ task, from }) => {
                lines.push(`- **${task.title}** (was: ${from}${task.due_date ? `, due: ${task.due_date}` : ""})`);
              });
              lines.push("");
            }
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    },
    {
      name: "prioritizer_stats",
      description: "Get task distribution statistics by priority, status, and context",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        try {
          const today = new Date().toISOString().split("T")[0];
          const byPriority = safeQuery(
            "SELECT priority, COUNT(*) as n FROM tasks WHERE status NOT IN ('done','blocked') GROUP BY priority ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END"
          );
          const overdue = safeGet(`SELECT COUNT(*) as n FROM tasks WHERE status NOT IN ('done','blocked') AND due_date < ?`, today)?.n ?? 0;
          const dueToday = safeGet(`SELECT COUNT(*) as n FROM tasks WHERE status NOT IN ('done','blocked') AND due_date = ?`, today)?.n ?? 0;
          const byContext = safeQuery(
            "SELECT context, COUNT(*) as n FROM tasks WHERE status NOT IN ('done','blocked') AND context <> '' GROUP BY context ORDER BY n DESC LIMIT 8"
          );

          const lines = ["# 📊 Task Priority Stats\n"];
          byPriority.forEach(row => {
            const bar = "█".repeat(Math.min(20, Math.round(row.n / 2)));
            lines.push(`**${row.priority.toUpperCase()}** ${bar} ${row.n}`);
          });
          lines.push("");
          lines.push(`⚠️ Overdue: **${overdue}** · Due today: **${dueToday}**`);

          if (byContext.length > 0) {
            lines.push("\n**By context:**");
            byContext.forEach(r => {
              lines.push(`  ${r.context}: ${r.n} tasks`);
            });
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    },
    {
      name: "prioritizer_focus",
      description: "Suggest a focus list: the top 3 tasks to work on right now based on priority, due date, and context",
      inputSchema: {
        type: "object",
        properties: {
          context: { type: "string", description: "GTD context filter (e.g. @work)" },
          max: { type: "number", description: "Max tasks in focus (default: 3)" },
        },
      },
      handler: async (args) => {
        if (!_db) return { content: [{ type: "text", text: "Skill not initialized" }] };
        const max = args.max ?? 3;
        const today = new Date().toISOString().split("T")[0];
        try {
          let sql = `SELECT * FROM tasks WHERE status IN ('todo','in_progress')
            ORDER BY
              CASE WHEN due_date < ? THEN 0 WHEN due_date = ? THEN 1 ELSE 2 END,
              CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
              CASE status WHEN 'in_progress' THEN 0 ELSE 1 END
            LIMIT ?`;
          const params = [today, today, max];

          if (args.context) {
            sql = `SELECT * FROM tasks WHERE status IN ('todo','in_progress') AND context = ?
              ORDER BY
                CASE WHEN due_date < ? THEN 0 WHEN due_date = ? THEN 1 ELSE 2 END,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
              LIMIT ?`;
            params.unshift(args.context);
          }

          const tasks = _db.prepare(sql).all(...params);

          if (tasks.length === 0) {
            return { content: [{ type: "text", text: "🎉 No tasks to focus on. All clear!" }] };
          }

          const lines = ["# 🎯 Focus Now\n"];
          tasks.forEach((t, i) => {
            const pri = t.priority === "urgent" ? "🔴" : t.priority === "high" ? "🟠" : "🔵";
            const due = t.due_date ? (t.due_date < today ? " ⚠️ OVERDUE" : ` (due: ${t.due_date})`) : "";
            const status = t.status === "in_progress" ? " 🔄" : "";
            lines.push(`${i + 1}. ${pri} **${t.title}**${due}${status}`);
            if (t.description) lines.push(`   ${t.description.slice(0, 120)}`);
          });

          // Productivity score
          const doneToday = safeGet(`SELECT COUNT(*) as n FROM tasks WHERE status = 'done' AND updated_at >= ?`, today + "T00:00:00Z");
          if (doneToday?.n > 0) {
            lines.push(`\n✅ Already completed **${doneToday.n}** task${doneToday.n > 1 ? "s" : ""} today`);
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

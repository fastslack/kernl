import Database from "better-sqlite3";
const db = new Database("./data/kernel.db");

const total = (db.prepare("SELECT COUNT(*) as c FROM issues").get() as { c: number }).c;
const open = (db.prepare("SELECT COUNT(*) as c FROM issues WHERE state = 'open'").get() as { c: number }).c;
const withMilestone = (db.prepare("SELECT COUNT(*) as c FROM issues WHERE milestone <> ''").get() as { c: number }).c;
const withAssignees = (db.prepare("SELECT COUNT(*) as c FROM issues WHERE assignees <> '' AND assignees <> '[]'").get() as { c: number }).c;
const withTimeEstimate = (db.prepare("SELECT COUNT(*) as c FROM issues WHERE time_estimate > 0").get() as { c: number }).c;
const withTimeSpent = (db.prepare("SELECT COUNT(*) as c FROM issues WHERE time_spent > 0").get() as { c: number }).c;
const labelsCount = (db.prepare("SELECT COUNT(*) as c FROM issue_labels").get() as { c: number }).c;
const uniqueLabels = (db.prepare("SELECT COUNT(DISTINCT label) as c FROM issue_labels").get() as { c: number }).c;
const stale = (db.prepare("SELECT COUNT(*) as c FROM issues WHERE state = 'open' AND julianday('now') - julianday(updated_at) >= 14").get() as { c: number }).c;

console.log("=== DATA ANALYSIS ===");
console.log("Total issues:", total);
console.log("Open:", open);
console.log("With milestone:", withMilestone);
console.log("With assignees (non-empty):", withAssignees);
console.log("With time_estimate:", withTimeEstimate);
console.log("With time_spent:", withTimeSpent);
console.log("Labels count:", labelsCount, "(", uniqueLabels, "unique)");
console.log("Stale (14d+):", stale);
console.log("");

const repos = db.prepare("SELECT repo, COUNT(*) as c, SUM(CASE WHEN state='open' THEN 1 ELSE 0 END) as open FROM issues GROUP BY repo ORDER BY c DESC").all();
console.log("Repos:", JSON.stringify(repos, null, 2));

const milestones = db.prepare("SELECT milestone, COUNT(*) as c FROM issues WHERE milestone <> '' GROUP BY milestone ORDER BY c DESC LIMIT 10").all();
console.log("\nMilestones:", JSON.stringify(milestones, null, 2));

const topAssignees = db.prepare("SELECT j.value as assignee, COUNT(*) as c FROM issues i, json_each(CASE WHEN i.assignees = '' THEN '[]' ELSE i.assignees END) j WHERE i.state = 'open' GROUP BY j.value ORDER BY c DESC LIMIT 10").all();
console.log("\nTop assignees (open):", JSON.stringify(topAssignees, null, 2));

const sampleAssignees = db.prepare("SELECT id, assignees FROM issues WHERE assignees <> '' AND assignees <> '[]' LIMIT 5").all();
console.log("\nSample assignees values:", JSON.stringify(sampleAssignees, null, 2));

const topLabels = db.prepare("SELECT label, COUNT(*) as c FROM issue_labels GROUP BY label ORDER BY c DESC LIMIT 15").all();
console.log("\nTop labels:", JSON.stringify(topLabels, null, 2));

const velocity = db.prepare(`
  SELECT
    strftime('%Y-W%W', created_at) as week,
    SUM(CASE WHEN state = 'open' OR closed_at IS NOT NULL THEN 1 ELSE 0 END) as created,
    SUM(CASE WHEN closed_at IS NOT NULL AND strftime('%Y-W%W', closed_at) = strftime('%Y-W%W', created_at) THEN 1 ELSE 0 END) as same_week_closed
  FROM issues
  GROUP BY week
  ORDER BY week DESC
  LIMIT 12
`).all();
console.log("\nVelocity (recent weeks):", JSON.stringify(velocity, null, 2));

db.close();

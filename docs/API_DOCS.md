# API Reference

All endpoints are served at `http://localhost:3086` (or your configured port).

## Authentication

If `KERNEL_AUTH_TOKEN` is set, all `/api/*` endpoints require:

```
Authorization: Bearer <your-token>
```

Exempt: `/api/health`, `/api/auth/verify`

## Health & Auth

### GET /api/health
No authentication required.

```bash
curl http://localhost:3086/api/health
```
```json
{
  "status": "ok",
  "uptimeMs": 123456,
  "uptimeFormatted": "0h 2m 3s",
  "services": { "sqlite": true, "neo4j": true, "dashboard": true }
}
```

### GET /api/auth/verify
Verify if a token is valid.

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3086/api/auth/verify
```
```json
{ "valid": true, "authEnabled": true }
```

## Dashboard

### GET /api/dashboard
Full dashboard data (KPIs + tasks + CRM + reminders + shopping).

### GET /api/dashboard/kpis
Summary counts across modules.

### GET /api/dashboard/{section}
Section-specific data. Available sections:

| Section | Description |
|---------|-------------|
| `tasks` | Task breakdown (by status, priority, context, velocity) |
| `crm` | Contacts by relationship, stale contacts, recent interactions |
| `reminders` | Upcoming, overdue, by status |
| `shopping` | Active lists, low stock, recent purchases |
| `home` | Maintenance, projects, incidents, warranties |
| `comms` | Communications, threads, email accounts |
| `analytics` | Contact insights + Neo4j network analytics |
| `life` | Weather, AQI, sun/moon, currencies, clocks, habits |
| `issues` | GitHub/GitLab issues, velocity, milestones |
| `events` | Upcoming events, RSVPs, attendance |
| `finance` | Accounts, transactions, budgets |
| `health` | Metrics, medications, appointments |
| `training` | Workouts, cardio, PRs, programs |
| `nutrition` | Meals, macros, water, fasting |
| `subscriptions` | Active subscriptions, billing |
| `notes` | Recent notes, pinned, by tag |
| `goals` | Active goals, key results, progress |
| `vehicles` | Fleet, maintenance, fuel, incidents |
| `meals` | Recipes, meal plans, logs |
| `documents` | Documents, expiry tracking |
| `web-intel` | Research tasks, results |
| `agents` | AI agents, runs, triggers |
| `chat` | Chat episodes, extractions |
| `agenda` | 14-day agenda (tasks + reminders + events) |
| `calendar` | Calendar view with events from all modules |

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3086/api/dashboard/tasks
```

## Mutations

### Tasks

```bash
# Create task
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Buy groceries","priority":"high"}' \
  http://localhost:3086/api/tasks/create

# Update status
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"id":"<task-id>","status":"done"}' \
  http://localhost:3086/api/tasks/update-status
```

### Reminders

```bash
# Dismiss
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"id":"<reminder-id>"}' \
  http://localhost:3086/api/reminders/dismiss

# Snooze (minutes)
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"id":"<reminder-id>","minutes":30}' \
  http://localhost:3086/api/reminders/snooze
```

### Shopping

```bash
# Check item
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"id":"<item-id>","checked":true}' \
  http://localhost:3086/api/shopping/check-item
```

## Notifications

### GET /api/notifications
List notifications. Query params: `?unreadOnly=1&limit=50`

### POST /api/notifications/read
Mark as read: `{"id":"<id>"}` or mark all: `{"all":true}`

### DELETE /api/notifications
Delete: `{"id":"<id>"}`

## Channels

### GET /api/channels
List all notification channel providers with status.

### POST /api/channels/start
Start a channel: `{"id":"telegram"}`

### POST /api/channels/stop
Stop a channel: `{"id":"telegram"}`

### POST /api/channels/test
Send test notification: `{"id":"telegram"}`

## WebSocket

Connect to `ws://localhost:3086/ws` (add `?token=<token>` if auth enabled).

Messages are JSON:
```json
{
  "type": "dashboard" | "tasks" | "life" | "notification" | ...,
  "data": { ... }
}
```

The server pushes updates when data changes (via MCP tool calls or scheduled refreshes).

## MCP (Model Context Protocol)

### POST /mcp
Streamable HTTP MCP endpoint. See [MCP specification](https://modelcontextprotocol.io).

First request creates a session (returns `mcp-session-id` header). Subsequent requests include the session ID.

Available tools: ~190+ tools across all modules. Use `ListTools` to discover.

## Rate Limiting

- HTTP API: 200 requests/minute per IP
- Messaging channels: 30 messages/minute per user
- Exceeded: returns `429 Too Many Requests`

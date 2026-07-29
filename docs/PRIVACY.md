# Privacy Policy

Kernl is a **local-first, self-hosted** personal life management server. Your data stays on your machine.

## What Data Is Stored

| Category | Data | Storage |
|----------|------|---------|
| Tasks | Title, description, status, priority, due dates | SQLite |
| Contacts | Name, email, phone, company, relationship, interaction history | SQLite + Neo4j (optional) |
| Communications | Email drafts, sent messages, threads, attachments | SQLite + filesystem |
| Reminders | Title, trigger time, recurrence, snooze state | SQLite |
| Shopping | Products, lists, purchases, prices | SQLite |
| Home | Appliances, maintenance, projects, incidents, vendors | SQLite |
| Events | Group events, attendees, RSVPs, waitlists | SQLite |
| Health | Metrics (weight, blood pressure, etc.), medications, appointments | SQLite |
| Finance | Accounts, transactions, budgets | SQLite |
| Training | Workouts, sets, cardio, personal records, programs | SQLite |
| Nutrition | Meals, macros, water intake, fasting, body stats | SQLite |
| Documents | Metadata (title, category, expiry) -- no file content | SQLite |
| Notes | Title, body (markdown), tags | SQLite + FTS5 |
| Chat | Conversation episodes, messages, extracted entities | SQLite + Neo4j |
| Life Log | Habits, mood, water intake, exercise, notes | SQLite |

## Where Data Is Stored

- **SQLite database**: `./data/kernel.db` (configurable via `SQLITE_PATH`)
- **Neo4j graph** (optional): Local Docker container, not cloud
- **Attachments**: `./data/attachments/` directory
- **Embeddings**: Computed locally using `Xenova/all-MiniLM-L6-v2` ONNX model (no cloud inference)

All data resides on your machine. There is no cloud storage, no remote database, no data replication to external services.

## External API Calls

### Always local (no external calls)
- Task management, contacts, reminders, shopping, home, events, finance, training, nutrition
- Text embeddings (local ONNX model)
- Moon phase, golden hour, holidays (computed locally)

### Public APIs (no authentication, no user data sent)

| API | Data Sent | Data Received | When Called |
|-----|-----------|---------------|-------------|
| Open-Meteo | Latitude, longitude | Weather, AQI, pollen, UV | Dashboard life panel (cached 15-30 min) |
| sunrise-sunset.org | Latitude, longitude | Sunrise/sunset times | Dashboard life panel (cached 1 hour) |
| frankfurter.dev | Currency pairs | Exchange rates | Dashboard life panel (cached 1 hour) |
| USGS Earthquakes | None | Recent earthquake data | Dashboard life panel (cached 30 min) |

**No user data, personal information, or identifiers are sent to these APIs.**

### Optional Services (user-configured, opt-in only)

| Service | When Used | What Is Sent |
|---------|-----------|--------------|
| Google OAuth | Contacts/Gmail sync | OAuth tokens (to Google only) |
| Anthropic/OpenAI | Chat, web intelligence, email analysis | Prompts (PII-filtered by default) |
| Telegram/Slack/Discord | Messaging channels | Messages to configured bot |
| Mattermost | Notifications | Notification text to configured webhook |
| Resend | Email sending | Email content to Resend API |
| CoinGecko | Sector discovery (trading) | None (public API, no auth) |
| Bitvavo | Crypto trading | Trading orders (configured exchange) |

**These services are NEVER called unless you explicitly configure API keys and enable the feature.**

## PII Protection

When enabled (default: on), the PII filter automatically redacts sensitive data before sending to external LLM APIs:
- Email addresses
- Phone numbers
- Credit card numbers
- IBANs
- Social security numbers
- IP addresses
- Passport numbers

Configure via `PII_FILTER_ENABLED` (default: `true`).

## Telemetry

**Kernl collects zero telemetry.** There are no analytics, no usage tracking, no crash reporting, no phone-home calls. The application makes no network requests unless you explicitly configure an external service.

## Data Export

Export all your data using the backup script:
```bash
./scripts/backup.sh ~/my-backup.zip
```
This creates a portable zip containing your SQLite database, configuration, and attachments.

## Data Deletion

- **Delete everything**: Remove the `./data/` directory
- **Delete specific records**: Use MCP tools (e.g., `kernel_crm_delete_contact`, `kernel_tasks_delete`)
- **Soft deletes**: Home appliances, projects, incidents, vehicles, and documents use soft deletes (recoverable)
- **Hard deletes**: Tasks, contacts, reminders, and most other records are permanently deleted

## Data Retention

Data is retained indefinitely until you delete it. There is no automatic data expiration except:
- Notification history (can be purged via dashboard)
- Market snapshots (trading module, 48-hour TTL)
- WebSocket connection state (ephemeral, in-memory only)

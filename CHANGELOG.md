# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-20

### Added
- 48 self-contained modules (tasks, CRM, reminders, shopping, home, events, finance, health, training, nutrition, trading, agents, chat, and more)
- ~190 MCP tools for Claude Desktop integration
- Web dashboard (SvelteKit SPA) with 20+ views
- Multi-channel notifications (Telegram, Slack, Discord, WhatsApp, Mattermost, WebChat)
- Neo4j graph analytics (optional) with GDS algorithms
- Life Intelligence panel (weather, AQI, moon, currencies, earthquakes)
- AI agents with scheduling, triggers, feedback loops
- Trading module with technical analysis and graph-based signals
- Cognitive chat with episodic memory and context retrieval
- Google Contacts/Gmail sync
- API authentication (Bearer token)
- Encrypted secrets (AES-256-GCM)
- PII filter for LLM calls
- Backup/restore scripts
- Docker Compose deployment (separated frontend/backend containers)
- GitHub Actions CI pipeline

### Security
- API authentication via KERNEL_AUTH_TOKEN
- WebSocket authentication via token query param
- Configurable CORS (CORS_ALLOWED_ORIGINS)
- Marketplace secrets encrypted at rest
- Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- HTTP rate limiting (200 req/min per IP)
- SSRF protection in web intelligence fetcher

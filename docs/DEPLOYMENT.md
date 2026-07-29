# Kernl Deployment Guide

## Systemd Service

Create a service file at `/etc/systemd/system/kernl.service`:

```ini
[Unit]
Description=Kernl
After=network.target

[Service]
Type=simple
User=kernl
WorkingDirectory=/opt/Kernl
ExecStart=/usr/local/bin/bun run dist/mcp-server.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/Kernl/.env

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable kernl
sudo systemctl start kernl
sudo systemctl status kernl
```

View logs:

```bash
journalctl -u kernl -f
journalctl -u kernl --since "1 hour ago"
```

## Docker (Separated Containers)

Start all services:

```bash
docker compose up -d
```

Rebuild only backend:

```bash
docker compose up -d --build kernel
```

Rebuild only frontend:

```bash
docker compose up -d --build dashboard
```

### Ports

| Service          | Port  | Description       |
|------------------|-------|-------------------|
| Dashboard (SPA)  | 3086  | SvelteKit frontend|
| API / MCP HTTP   | 3087  | Backend API       |
| Neo4j Browser    | 17474 | Web UI            |
| Neo4j Bolt       | 17687 | Driver protocol   |

### Container Management

```bash
docker compose ps              # Check status
docker compose logs kernel -f  # Follow backend logs
docker compose logs neo4j -f   # Follow Neo4j logs
docker compose down            # Stop all
docker compose down -v         # Stop and remove volumes (destructive)
```

## Reverse Proxy (Nginx)

Example configuration with HTTPS via Certbot/Let's Encrypt.

```nginx
server {
    listen 80;
    server_name kernel.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name kernel.example.com;

    ssl_certificate /etc/letsencrypt/live/kernel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kernel.example.com/privkey.pem;

    # API and MCP endpoints
    location /api/ {
        proxy_pass http://127.0.0.1:3087;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /mcp {
        proxy_pass http://127.0.0.1:3087;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:3087;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }

    # SPA fallback
    location / {
        proxy_pass http://127.0.0.1:3086;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Generate certificates:

```bash
sudo certbot --nginx -d kernel.example.com
```

## Environment Checklist

### Required

| Variable              | Description                          |
|-----------------------|--------------------------------------|
| `SQLITE_PATH`         | Path to SQLite database file         |
| `KERNEL_AUTH_TOKEN`    | Bearer token for API authentication  |
| `KERNEL_ENCRYPTION_KEY`| AES-256-GCM key for secrets at rest |

### Recommended

| Variable              | Description                          |
|-----------------------|--------------------------------------|
| `CORS_ALLOWED_ORIGINS`| Comma-separated allowed origins      |
| `NEO4J_PASSWORD`      | Change from default (`password`)     |
| `LOG_LEVEL`           | Set to `warn` or `error` in prod     |
| `MCP_TRANSPORT`       | `http` for daemon mode               |
| `TIMEZONE`            | e.g. `Europe/London`, `UTC`, `America/New_York` |

### Optional (Channels)

All channel configurations (Telegram, Slack, Discord, WhatsApp, Mattermost) are stored in the marketplace database after initial setup. See `.env.example` for the full list of environment variables.

## Monitoring

### Health Check

```bash
curl http://localhost:3087/api/health
```

Returns uptime, module count, and database status.

### Prometheus Metrics

```bash
curl http://localhost:3087/api/metrics
```

### Logs

Kernel logs to stderr. Capture with systemd or Docker logging:

```bash
# Systemd
journalctl -u kernl -f

# Docker
docker compose logs kernel -f --tail 100
```

## Backup

### Manual Backup

```bash
./scripts/backup.sh ~/backup.zip
```

This archives the SQLite database, attachments, and configuration.

### Automated Backup (Cron)

```bash
crontab -e
```

Add a nightly backup at 03:00:

```
0 3 * * * /opt/Kernl/scripts/backup.sh /backups/mtw-$(date +\%Y\%m\%d).zip
```

### Restore

```bash
./scripts/restore.sh ~/backup.zip
```

### Neo4j Backup

Neo4j data is persisted in Docker volumes. For a full backup:

```bash
docker compose stop neo4j
docker run --rm -v kernl_neo4j-data:/data -v $(pwd)/backups:/backup alpine tar czf /backup/neo4j-data.tar.gz /data
docker compose start neo4j
```

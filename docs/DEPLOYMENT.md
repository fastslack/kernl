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
bash services/kernel/scripts/backup.sh ~/backup.zip
```

This archives the SQLite database, the generated secrets, and configuration.

### Automated Backup (Cron)

```bash
crontab -e
```

Add a nightly backup at 03:00 — from the repo directory, since Docker mode
needs the compose file:

```
0 3 * * * cd /path/to/kernl && bash services/kernel/scripts/backup.sh /backups/kernl-$(date +\%Y\%m\%d).zip || echo "kernl backup FAILED" | mail -s "kernl backup" you@example.com
```

`backup.sh` detects the deployment: with the Docker stack running it snapshots
the database inside the `kernel-data` volume; otherwise it uses the local data
dir. Force one with `KERNEL_BACKUP_MODE=docker|native`, and point native mode at
a specific directory with `KERNEL_BACKUP_DATA_DIR`.

The snapshot goes through SQLite (`VACUUM INTO`) rather than copying the file:
the kernel holds the database open in WAL mode, so a file copy silently loses
everything written since the last checkpoint. The archive also carries
`.kernel-encryption-key` — without it, every encrypted secret in a restored
database is unreadable.

The script verifies the snapshot (`PRAGMA integrity_check` plus a table count)
before calling it a backup, and exits non-zero if anything failed. Check that
exit code in cron; a backup problem you don't hear about is one you discover at
restore time.

### Restore

```bash
# Docker stack (stops the kernel, restores into the volume, starts it again)
bash services/kernel/scripts/restore.sh ~/backup.zip --docker /path/to/kernl

# Package or source install — <data-dir> is the directory holding kernel.db
bash services/kernel/scripts/restore.sh ~/backup.zip --native ~/.local/share/kernl/data
```

Restoring replaces the target database, so it asks for confirmation; pass
`--yes` for automation. The target mode is explicit on purpose — an earlier
version guessed, guessed the repo's `./data`, and so "restored" a Docker
deployment into a directory nothing reads.

### Neo4j Backup

`backup.sh` already dumps Neo4j when the Docker stack is up (skip it with
`KERNEL_BACKUP_SKIP_NEO4J=1`; the graph rebuilds from SQLite). To archive the
volume by hand instead:

```bash
docker compose stop neo4j
# The volume is prefixed with the compose project name (`name: kernl-public`
# in docker-compose.yml). Confirm yours with `docker volume ls` — naming a
# volume that doesn't exist makes `docker run -v` create an empty one and tar
# nothing, with a zero exit code.
docker run --rm -v kernl-public_neo4j-data:/data -v "$(pwd)/backups:/backup" \
  alpine tar czf /backup/neo4j-data.tar.gz /data
docker compose start neo4j
```

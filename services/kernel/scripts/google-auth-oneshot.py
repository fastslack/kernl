#!/usr/bin/env python3
"""
One-shot Google OAuth re-authentication.

Flow:
  1. Read GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from ./.env
  2. Start an ephemeral HTTP server on localhost:8787 (host-side, not container)
  3. Open the browser to Google OAuth consent with redirect_uri=http://localhost:8787/callback
     (that URI is whitelisted because it's the legacy kernel_google_auth flow and
      GOOGLE_CALLBACK_PORT=8787 is in .env)
  4. User clicks Allow → Google redirects to /callback?code=...
  5. Exchange code for {access_token, refresh_token, expires_at, scopes}
  6. Write tokens directly to ./data/kernel.db (volume-mounted by the kernel container)
  7. Restart kernel container so it re-reads the new tokens

No rebuilds. No Google Console changes. One click.
"""

import http.server
import json
import os
import sqlite3
import subprocess
import sys
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, ".env")
DB_FILE = os.path.join(ROOT, "data", "kernel.db")
CALLBACK_PORT = 8787
REDIRECT_URI = f"http://localhost:{CALLBACK_PORT}/callback"

SCOPES = [
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/contacts.other.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/tasks.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]


def read_env(path: str) -> dict[str, str]:
    env: dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def build_auth_url(client_id: str) -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
    }
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)


def exchange_code(code: str, client_id: str, client_secret: str) -> dict:
    body = urllib.parse.urlencode({
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def save_tokens(db_path: str, data: dict) -> None:
    if "refresh_token" not in data:
        raise RuntimeError(
            "No refresh_token in response. Go to https://myaccount.google.com/permissions, "
            "remove Kernl access entirely, then re-run this script."
        )

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    expires_at = datetime.fromtimestamp(
        datetime.now(timezone.utc).timestamp() + int(data["expires_in"]),
        tz=timezone.utc,
    ).isoformat().replace("+00:00", "Z")

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("""
            INSERT INTO google_tokens (id, access_token, refresh_token, expires_at, scopes, updated_at)
            VALUES (1, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              access_token = excluded.access_token,
              refresh_token = excluded.refresh_token,
              expires_at = excluded.expires_at,
              scopes = excluded.scopes,
              updated_at = excluded.updated_at
        """, (
            data["access_token"],
            data["refresh_token"],
            expires_at,
            data.get("scope", ""),
            now,
        ))
        conn.commit()
    finally:
        conn.close()

    print(f"✓ Tokens saved to {db_path}")
    print(f"  expires_at: {expires_at}")
    print(f"  scopes: {data.get('scope', '')}")


received: dict[str, str] = {}


class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress default logging

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return

        qs = urllib.parse.parse_qs(url.query)
        if "error" in qs:
            received["error"] = qs["error"][0]
            self.send_response(400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"<h2>Authorization denied</h2><p>{qs['error'][0]}</p>".encode())
            return

        if "code" not in qs:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Missing code")
            return

        received["code"] = qs["code"][0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"""
            <html><body style="font-family:system-ui;padding:40px;background:#0d0f18;color:#e0e2ea">
            <h1 style="color:#3DD68C">Kernl authorized</h1>
            <p>You can close this tab and return to your terminal.</p>
            <script>setTimeout(()=>window.close(), 1500);</script>
            </body></html>
        """)


def main() -> int:
    if not os.path.exists(ENV_FILE):
        print(f"ERROR: .env not found at {ENV_FILE}", file=sys.stderr)
        return 1
    if not os.path.exists(DB_FILE):
        print(f"ERROR: kernel.db not found at {DB_FILE}", file=sys.stderr)
        return 1

    env = read_env(ENV_FILE)
    client_id = env.get("GOOGLE_CLIENT_ID", "")
    client_secret = env.get("GOOGLE_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        print("ERROR: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing from .env", file=sys.stderr)
        return 1

    auth_url = build_auth_url(client_id)

    print(f"Starting callback server on http://localhost:{CALLBACK_PORT}/callback")
    try:
        server = http.server.HTTPServer(("127.0.0.1", CALLBACK_PORT), CallbackHandler)
    except OSError as e:
        print(f"ERROR: cannot bind port {CALLBACK_PORT}: {e}", file=sys.stderr)
        print("Another process is using it. Kill it and retry.", file=sys.stderr)
        return 1

    print(f"Opening browser...")
    print(f"  If it doesn't open, paste this URL manually:\n  {auth_url}\n")
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass

    print("Waiting for Google callback...")
    while "code" not in received and "error" not in received:
        server.handle_request()

    server.server_close()

    if "error" in received:
        print(f"ERROR: Google denied the consent: {received['error']}", file=sys.stderr)
        return 1

    print("Exchanging code for tokens...")
    try:
        data = exchange_code(received["code"], client_id, client_secret)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"ERROR: token exchange failed ({e.code}): {body}", file=sys.stderr)
        return 1

    save_tokens(DB_FILE, data)

    print("\nRestarting kernel container so it reloads the new tokens...")
    try:
        subprocess.run(
            ["docker", "compose", "restart", "kernel"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        print("✓ kernel restarted")
    except subprocess.CalledProcessError as e:
        print(f"WARN: restart failed: {e.stderr}", file=sys.stderr)
        print("Run manually: docker compose restart kernel", file=sys.stderr)

    print("\n✓ DONE. Your Gmail sync should work on the next cron tick.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

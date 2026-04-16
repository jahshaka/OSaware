# OSAWARE Production Deployment Runbook

**Target:** Clean Ubuntu 22.04 LTS on AWS Lightsail → fully working production OSAWARE at `https://www.osaware.com/` and `https://osaware.com/`
**Pattern:** Single server hosts BOTH the JavaScript frontend AND the Node.js backend API behind nginx
**Time:** 30-60 minutes end-to-end for a fresh box
**Prerequisite:** You already have a Lightsail instance running Ubuntu 22.04 (or 24.04) with SSH access, and DNS A records pointing `www.osaware.com` and `osaware.com` at the instance's static IP

---

## Architecture overview

```
                          ┌──────────────────────────────────┐
                          │  Lightsail Ubuntu 22.04 Instance │
                          │                                  │
   Internet ──────┐       │  ┌────────────┐                  │
                  │       │  │   nginx    │  (ports 80/443)  │
   :443 (HTTPS) ──┼──────►│  │            │                  │
                  │       │  │  /         ──► static files   │
   :80  (HTTP)  ──┘       │  │            │   /srv/osaware-  │
                          │  │  /api/*    │   frontend/      │
                          │  │     │      │                  │
                          │  │     ▼      │                  │
                          │  │  proxy     │                  │
                          │  │            │                  │
                          │  └─────┬──────┘                  │
                          │        │                         │
                          │        ▼                         │
                          │  ┌────────────┐                  │
                          │  │ Node.js    │  (port 3000)     │
                          │  │  server.js │                  │
                          │  │            │                  │
                          │  │  runs as:  │                  │
                          │  │  osaware   │  (nologin user)  │
                          │  │            │                  │
                          │  │  managed:  │                  │
                          │  │  systemd   │                  │
                          │  └─────┬──────┘                  │
                          │        │                         │
                          │        ▼                         │
                          │  ┌────────────┐                  │
                          │  │ SQLite DB  │                  │
                          │  │ + filesys  │                  │
                          │  │ binary     │                  │
                          │  │ assets     │                  │
                          │  │            │                  │
                          │  │ /srv/      │                  │
                          │  │ osaware-   │                  │
                          │  │ data/      │                  │
                          │  └────────────┘                  │
                          └──────────────────────────────────┘
```

**Why same-server (Pattern A) instead of split frontend/backend:**

- **No CORS.** Frontend and backend share the same origin, so session cookies "just work" with `HttpOnly; Secure; SameSite=Strict` — the strongest possible cookie security posture. Split deployment would require relaxing to `SameSite=None` with all the tradeoffs that implies.
- **One domain, one TLS cert, one nginx config.** Operational simplicity.
- **Frontend is tiny static content** — nginx serves it in microseconds. No reason to push it to a CDN when the Lightsail instance is already there.
- **Deploys and backups are unified.** One box to manage.

---

## Prerequisites checklist

Before you start, confirm:

- [ ] Lightsail instance running, static IP attached, SSH working
- [ ] DNS A record for `www.osaware.com` → static IP (verify with `dig +short www.osaware.com` from anywhere)
- [ ] DNS A record for `osaware.com` → same static IP
- [ ] Lightsail web console firewall has ports 22, 80, **and 443** open (this is the AWS-layer firewall, separate from UFW inside the box)
- [ ] You have the two deploy artifacts locally on your laptop:
   - `osaware-backend-v1.0.zip` (backend source — nine files, ~30 KB)
   - `ngbasic-Alpha-V7B23.zip` (or later — frontend build, ~1.6 MB)

SSH in as `ubuntu`:

```bash
ssh -i /path/to/lightsail-key.pem ubuntu@YOUR_LIGHTSAIL_STATIC_IP
```

Everything below runs on the Lightsail box unless it explicitly says "on your laptop."

---

## Phase 1 — System update and prerequisites

```bash
sudo apt update && sudo apt upgrade -y

sudo apt install -y \
    curl ca-certificates gnupg \
    build-essential python3 \
    git unzip rsync \
    nginx ufw \
    dnsutils sqlite3
```

What each does:
- `build-essential python3` — needed if `better-sqlite3` or `bcrypt` have to compile from source during `npm install`. They usually grab prebuilt binaries, but having the toolchain present means `npm install` won't fail if the prebuilt isn't available for this arch.
- `nginx` — the reverse proxy that serves the frontend and proxies the API
- `ufw` — OS-level firewall (defence in depth alongside the Lightsail web console firewall)
- `dnsutils` — provides `dig` for verifying DNS
- `sqlite3` — the CLI, needed by the nightly backup script (the backend itself uses the `better-sqlite3` Node package and doesn't need the CLI)

---

## Phase 2 — Install Node.js 20 LTS

Ubuntu 22.04's apt repos ship Node 12, which is far too old. Use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node --version    # v20.x.x
npm --version     # 10.x.x
```

Node 20 LTS has support through April 2026; Node 22 also works but 20 is the safer choice for a "set and forget" production box.

---

## Phase 3 — Create a dedicated service user

Don't run the backend as `ubuntu` or `root`. Create a system user with no login shell:

```bash
sudo useradd --system --shell /usr/sbin/nologin --home /srv/osaware --create-home osaware
```

This user:
- Cannot log in via SSH (no shell)
- Cannot be `su`'d into normally (nologin shell)
- Runs the Node process via systemd
- Owns the backend code and data directories

**How to run commands as this user:** `sudo -u osaware <command>`. Since there's no shell, you can't `su osaware` or `sudo -i -u osaware` normally. For interactive work (rare), use `sudo -i -u osaware -s /bin/bash` to force bash.

---

## Phase 4 — Directory layout

```bash
# Backend code lives here, owned by osaware
sudo mkdir -p /srv/osaware

# Persistent data — SQLite db and per-user binary assets
sudo mkdir -p /srv/osaware-data/users

# Frontend static files — served by nginx
sudo mkdir -p /srv/osaware-frontend

# Backups — nightly cron writes here
sudo mkdir -p /srv/backups

# Application logs
sudo mkdir -p /var/log/osaware

# Ownership:
sudo chown -R osaware:osaware /srv/osaware /srv/osaware-data /var/log/osaware
sudo chown -R ubuntu:www-data /srv/osaware-frontend
sudo chown root:root /srv/backups

# Permissions:
# 755 on osaware dirs so `ubuntu` can cd in and ls for inspection.
# Files inside are 644/owned-by-osaware so they're still write-protected
# from ubuntu. Only root or osaware can modify them.
sudo chmod 755 /srv/osaware /srv/osaware-data /srv/osaware-data/users
# Frontend is ubuntu-writable (so you can deploy updates without sudo dance)
# and www-data-readable (so nginx can serve).
sudo chmod 755 /srv/osaware-frontend
```

**Rationale for mixed ownership:**

- `/srv/osaware/` (backend code) — owned by `osaware`. Sensitive. Only writable as `osaware` or `root`.
- `/srv/osaware-data/` — owned by `osaware`. Contains the user database and real user binary assets. Most sensitive. `755` on directories just so you can `ls` for inspection; files inside are mode 600/644 and unreadable/unwritable to `ubuntu`.
- `/srv/osaware-frontend/` — owned by `ubuntu:www-data`. Not sensitive (it's the exact same JS/HTML served to every visitor). Giving `ubuntu` write access makes deploys simple: `rsync` from your laptop → `/srv/osaware-frontend/` without any sudo.
- `/srv/backups/` — owned by `root`. Written by a cron job running as root. Protects against accidental deletion by lower-privileged accounts.

---

## Phase 5 — Upload backend code

**On your laptop:**

```bash
scp -i /path/to/lightsail-key.pem osaware-backend-v1.0.zip \
    ubuntu@YOUR_LIGHTSAIL_STATIC_IP:/tmp/
```

**Back on Lightsail:**

```bash
cd /tmp
sudo unzip -o osaware-backend-v1.0.zip -d /tmp/
sudo cp -r /tmp/osaware-backend/* /srv/osaware/
sudo chown -R osaware:osaware /srv/osaware
sudo rm -rf /tmp/osaware-backend /tmp/osaware-backend-v1.0.zip

# Verify nine files are in place
ls -la /srv/osaware/
# Expect: server.js, routes.js, auth.js, db.js, schema.sql,
#         test_unit.js, test_api.js, package.json, README.md
```

---

## Phase 6 — Install npm dependencies

```bash
cd /srv/osaware
sudo -u osaware npm install --omit=dev
```

Should take 30-60 seconds. Only two deps: `better-sqlite3` and `bcrypt`. Both have native code but both ship prebuilt binaries for common architectures. If either has to build from source, the `build-essential` + `python3` from Phase 1 cover it.

**If it fails:** read the error. Most common issues are permissions (forgot `sudo -u osaware`) or missing build tools (re-check Phase 1).

---

## Phase 7 — Run unit tests + manual boot smoke test

Before committing to systemd, verify the backend actually works:

```bash
# Run the 77 unit tests (path sanitisation, cookie parsing, validators, etc.)
sudo -u osaware node /srv/osaware/test_unit.js
```

Expected output ends with:
```
=== 77 passed, 0 failed ===
```

If anything fails, **stop and investigate**. Either the install is broken or there's a regression — don't continue until this passes.

Now boot the server manually to confirm it comes up:

```bash
sudo -u osaware OSAWARE_DATA_DIR=/srv/osaware-data node /srv/osaware/server.js
```

You should see:
```
[osaware] database: /srv/osaware-data/osaware.db
[osaware] data dir: /srv/osaware-data
[osaware] production mode: OFF
[osaware] listening on port 3000
```

Leave it running. In **another SSH session**:

```bash
curl http://localhost:3000/api/health
```

Expected: `{"ok":true,"name":"osaware-backend"}`

Go back to the first session and kill the server with `Ctrl+C`. We want systemd to manage it from here, not a manual process.

---

## Phase 8 — systemd service

Create the unit file:

```bash
sudo tee /etc/systemd/system/osaware.service > /dev/null <<'EOF'
[Unit]
Description=OSAWARE Backend
After=network.target

[Service]
Type=simple
User=osaware
Group=osaware
WorkingDirectory=/srv/osaware
ExecStart=/usr/bin/node /srv/osaware/server.js

# Environment
Environment=NODE_ENV=production
Environment=OSAWARE_PORT=3000
Environment=OSAWARE_DATA_DIR=/srv/osaware-data
Environment=OSAWARE_PRODUCTION=1

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/osaware-data /var/log/osaware

# Restart policy
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/osaware/server.log
StandardError=append:/var/log/osaware/server-error.log

[Install]
WantedBy=multi-user.target
EOF
```

What the hardening flags do:
- `User=osaware`, `Group=osaware` — never runs as root
- `NoNewPrivileges` — the process cannot gain privileges via setuid binaries
- `PrivateTmp` — gets its own isolated `/tmp` that disappears when the service stops
- `ProtectSystem=strict` — the entire filesystem is read-only from the service's perspective **except** the paths explicitly listed in `ReadWritePaths`
- `ProtectHome` — all user home directories are invisible to the service
- `ReadWritePaths=/srv/osaware-data /var/log/osaware` — the only paths the service can write to. Even if compromised, it cannot modify system files, the backend code, or any other user's data.

**About `OSAWARE_PRODUCTION=1`:** this enables `Secure; SameSite=Strict` cookie flags. Modern browsers refuse to store `Secure` cookies over plain HTTP, so **browser logins will not work until HTTPS is set up in Phase 11**. You can still exercise the API with curl using `-c/-b cookies.txt` during the HTTP-only window. Don't troubleshoot cookie issues until after HTTPS.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable osaware
sudo systemctl start osaware
sudo systemctl status osaware
```

Status should show `active (running)`. If it shows `failed`, check the logs:

```bash
sudo journalctl -u osaware -n 50 --no-pager
sudo cat /var/log/osaware/server-error.log
```

Test the service:

```bash
curl http://localhost:3000/api/health
```

Should still return the health JSON.

---

## Phase 9 — Upload and deploy the frontend

**On your laptop:**

```bash
scp -i /path/to/lightsail-key.pem ngbasic-Alpha-V7B23.zip \
    ubuntu@YOUR_LIGHTSAIL_STATIC_IP:/tmp/
```

**Back on Lightsail:**

```bash
cd /tmp
mkdir -p /tmp/osaware-extract
unzip -o ngbasic-Alpha-V7B23.zip -d /tmp/osaware-extract

# Verify the extract has the expected top-level layout
ls /tmp/osaware-extract/
# Expected: core/  docs/  files/  htaccess  index.html

# Deploy to the frontend directory
sudo rsync -a --delete /tmp/osaware-extract/ /srv/osaware-frontend/
sudo chown -R ubuntu:www-data /srv/osaware-frontend/
sudo chmod -R a+rX /srv/osaware-frontend/

# Clean up
rm -rf /tmp/osaware-extract /tmp/ngbasic-Alpha-V7B23.zip

# Verify key files are present
ls /srv/osaware-frontend/index.html
ls /srv/osaware-frontend/core/kernel.js
ls /srv/osaware-frontend/core/storage/remote_provider.js
ls /srv/osaware-frontend/core/auth/auth_service.js
```

All four `ls` should print the path. If any return "No such file," the unzip didn't grab everything.

**Save a deploy helper script for future frontend updates.** This is a one-time setup that saves typing on every subsequent build:

```bash
cat > ~/deploy-frontend.sh <<'EOF'
#!/bin/bash
# Deploy an OSAWARE frontend zip to /srv/osaware-frontend/
# Usage: ~/deploy-frontend.sh /tmp/ngbasic-Alpha-VXX.zip
set -e
ZIP="${1:?Usage: deploy-frontend.sh /path/to/ngbasic-Alpha-VXX.zip}"
EXTRACT=/tmp/osaware-extract-$$
mkdir -p "$EXTRACT"
unzip -oq "$ZIP" -d "$EXTRACT"
sudo rsync -a --delete "$EXTRACT/" /srv/osaware-frontend/
sudo chown -R ubuntu:www-data /srv/osaware-frontend/
sudo chmod -R a+rX /srv/osaware-frontend/
rm -rf "$EXTRACT"
echo "Deployed $ZIP"
EOF
chmod +x ~/deploy-frontend.sh
```

Future deploys:
```bash
~/deploy-frontend.sh /tmp/ngbasic-Alpha-V7B24.zip
```

---

## Phase 10 — nginx configuration

This is the key config. Serves the frontend from disk, proxies `/api/*` to the Node backend, handles both hostnames, and sets proper caching.

```bash
sudo tee /etc/nginx/sites-available/osaware > /dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name www.osaware.com osaware.com;

    # Document root for OSAWARE static frontend
    root /srv/osaware-frontend;
    index index.html;

    # Upload ceiling — binary assets are capped at 10 MB by the backend,
    # 15 MB here provides headroom for encoding overhead.
    client_max_body_size 15M;

    # Health check — no logging, no caching, no body inspection
    location = /api/health {
        proxy_pass http://127.0.0.1:3000;
        access_log off;
    }

    # All API endpoints — proxy to the Node backend on localhost:3000
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 60s;
    }

    # Static file serving with sensible caching
    location / {
        try_files $uri $uri/ =404;

        # JS / CSS / images / fonts — cache aggressively for a year.
        # The OSAWARE frontend uses ?v=<timestamp> cache-busting, so a
        # new build changes the URL and forces a fresh fetch. No risk.
        location ~* \.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|otf|ico)$ {
            add_header Cache-Control "public, immutable, max-age=31536000";
        }

        # HTML — never cache, so frontend updates appear instantly
        # (the HTML contains the ?v= stamp that busts everything else).
        location ~* \.html?$ {
            add_header Cache-Control "no-cache, no-store, must-revalidate";
        }
    }

    # Block hidden files and directories (.git, .htaccess, .env, etc.)
    location ~ /\. {
        deny all;
    }
}
EOF
```

**Critical caching note:** nginx's `expires` directive and `add_header Cache-Control` are **mutually exclusive** — using both emits duplicate `Cache-Control` headers, which browsers handle inconsistently. This config uses only `add_header` to stay clean. If you see `Cache-Control:` twice in a `curl -I` response, something else in the nginx tree is also setting it.

Enable the site, disable the default:

```bash
sudo ln -sf /etc/nginx/sites-available/osaware /etc/nginx/sites-enabled/osaware
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
```

`nginx -t` should print:
```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

If it errors, there's a syntax typo — fix it before reloading.

Reload nginx:

```bash
sudo systemctl reload nginx
```

Test from the box itself:

```bash
# Frontend serves on root
curl -I http://localhost/

# API proxies to backend
curl http://localhost/api/health
```

Both should succeed. The first returns `HTTP/1.1 200 OK` with `Content-Type: text/html`; the second returns the JSON health payload.

---

## Phase 11 — UFW firewall

OS-level firewall, defence-in-depth alongside the Lightsail web console firewall.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # opens both 80 and 443
sudo ufw --force enable
sudo ufw status verbose
```

Status should show `Status: active` and allow rules for 22 (SSH), 80 (HTTP), 443 (HTTPS). **Port 3000 is deliberately NOT opened** — the backend only listens on `127.0.0.1:3000` and is only reachable via the nginx proxy.

**Also confirm the Lightsail web console firewall has 443 open.** UFW allows something doesn't matter if AWS blocks it at the network layer. From the Lightsail web console:
- Click your instance → Networking tab → IPv4 Firewall
- Confirm rules exist for: SSH (22), HTTP (80), HTTPS (443)
- If HTTPS (443) is missing, click "Add rule" → Application: HTTPS → Save

This is the #1 cause of "HTTPS hangs but HTTP works" symptoms on fresh Lightsail boxes. Fix the web console firewall before running certbot.

---

## Phase 12 — HTTPS via Let's Encrypt

**Prerequisite:** DNS must actually resolve. Verify before running certbot:

```bash
dig +short www.osaware.com
dig +short osaware.com
```

Both should print the Lightsail static IP. If either is empty or wrong, fix DNS first and wait a few minutes for propagation. Running certbot against broken DNS will burn a rate-limited cert request.

Also sanity-check HTTP works by hostname (not just localhost):

```bash
curl -I http://www.osaware.com/api/health
curl -I http://osaware.com/api/health
```

Both should return `200 OK`. If either returns a timeout, connection refused, or a different server's response (some shared hosting injects landing pages for unconfigured domains), DNS is wrong and certbot will fail.

Install certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
```

Run it with both hostnames. The first `-d` is the primary (canonical) name:

```bash
sudo certbot --nginx -d www.osaware.com -d osaware.com
```

Prompts:
- **Email address:** use a real one — Let's Encrypt sends expiry warnings if renewal fails
- **Terms of service:** agree
- **Share email with EFF:** your call, no impact on the cert
- **Redirect HTTP to HTTPS:** **YES (option 2)**. This adds a `301 Moved Permanently` to the HTTP server block so users typing `http://osaware.com` get bumped to `https://www.osaware.com`.

Certbot rewrites `/etc/nginx/sites-available/osaware` in place to add:
- An HTTP → HTTPS redirect on the existing port 80 server block
- A new port 443 server block with SSL enabled and cert paths plugged in
- Listeners on both `www.osaware.com` and `osaware.com`

Verify:

```bash
sudo nginx -t
sudo cat /etc/nginx/sites-available/osaware
```

You should see two `server { ... }` blocks. Test both hostnames over HTTPS:

```bash
curl -I https://www.osaware.com/
curl -I https://osaware.com/

curl https://www.osaware.com/api/health
curl https://osaware.com/api/health
```

All four should succeed. Test that HTTP redirects:

```bash
curl -I http://www.osaware.com/
# Should return: HTTP/1.1 301 Moved Permanently
#                Location: https://www.osaware.com/
```

Verify auto-renewal is set up (certbot installs a systemd timer automatically):

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

The `--dry-run` simulates renewal without actually hitting Let's Encrypt's rate-limited production servers. If it prints "Congratulations, all renewals succeeded", real renewals will work when the cert approaches expiry (~30 days before). Certs are valid for 90 days; certbot renews at 60 days by default.

---

## Phase 13 — Final backend integration test against production

Now that HTTPS is up, run the 63-assertion backend smoke test against the **real production URL**:

```bash
sudo -u osaware OSAWARE_BASE=https://www.osaware.com node /srv/osaware/test_api.js
```

Expected:

```
=== 63 passed, 0 failed ===
```

This exercises every API endpoint: register, login, logout, whoami, storage round-trip, binary upload/download/delete, path traversal rejection, cross-user isolation. If all 63 pass, the backend is functionally correct end-to-end against production with real HTTPS and real cookies.

**If any fail,** paste the failing assertion labels and diagnose before continuing. Don't trust a half-working backend.

---

## Phase 14 — Open OSAWARE in a browser

From your laptop, visit `https://www.osaware.com/`. You should see the OSAWARE splash and BASIC prompt. Verify the four regression suites:

```
RUN TESTS          → 101/101 passed
RUN VFSTESTPROG    → 19/19 passed
RUN VFSAUTHTEST    → 23/23 passed
RUN VFSREALTEST    → 24/24 passed
```

Plus a live auth smoke test:

```
REGISTER "testaccount"
Enter password: ******    (type "test1234" — obfuscated as asterisks)
Registered and logged in as testaccount
(your LOCAL data is preserved and will return on LOGOUT)

WHOAMI
testaccount

VFSPUT "hello.txt", "hello from browser"
VFSGET$("hello.txt")
hello from browser

LOGOUT
Logged out (was testaccount)

WHOAMI
local

LOGIN "testaccount", "test1234"
Logged in as testaccount

VFSGET$("hello.txt")
hello from browser    ← proves the backend persisted the data across logout/login

LOGOUT
```

If all of the above works, **the deployment is complete.**

---

## Phase 15 — Nightly backup cron

Last piece. SQLite database + binary asset directory backed up every night, 14 days retention.

```bash
sudo tee /etc/cron.daily/osaware-backup > /dev/null <<'EOF'
#!/bin/bash
# Nightly backup of OSAWARE state. Runs via /etc/cron.daily, ~6am UTC.
set -e

DATE=$(date +%Y%m%d)
BACKUP_DIR=/srv/backups
SOURCE_DB=/srv/osaware-data/osaware.db
SOURCE_USERS=/srv/osaware-data/users

mkdir -p "$BACKUP_DIR"

# SQLite online backup — safe even while the server is running.
# .backup command acquires a shared lock, writes a consistent snapshot.
sqlite3 "$SOURCE_DB" ".backup '$BACKUP_DIR/osaware-$DATE.db'"

# Binary assets — rsync with --delete to mirror the current state.
rsync -a --delete "$SOURCE_USERS/" "$BACKUP_DIR/users-$DATE/"

# 14-day retention.
find "$BACKUP_DIR" -maxdepth 1 -name 'osaware-*.db' -mtime +14 -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'users-*' -type d -mtime +14 -exec rm -rf {} +
EOF

sudo chmod +x /etc/cron.daily/osaware-backup
```

Test it manually before relying on the scheduled run:

```bash
sudo /etc/cron.daily/osaware-backup
ls -la /srv/backups/
```

Should show `osaware-<todaydate>.db` and `users-<todaydate>/` directory. Both should be non-zero.

**Strongly recommended:** at least once, do a **restore dry-run** to prove the backup actually works:

```bash
# Copy a backup to a scratch location and open it read-only
cp /srv/backups/osaware-$(date +%Y%m%d).db /tmp/test-restore.db
sqlite3 -readonly /tmp/test-restore.db "SELECT id, username, created_at FROM users;"
rm /tmp/test-restore.db
```

If the SELECT returns actual user rows, the backup is valid and restorable. An untested backup is not a backup.

---

## Day-to-day operations

### Service management

```bash
# Status
sudo systemctl status osaware

# Restart after a code change
sudo systemctl restart osaware

# Stop/start
sudo systemctl stop osaware
sudo systemctl start osaware

# Live tail the application log
sudo journalctl -u osaware -f
sudo tail -f /var/log/osaware/server.log

# Last 100 lines
sudo journalctl -u osaware -n 100 --no-pager
```

### Deploy a new frontend build

```bash
# On your laptop:
scp -i lightsail-key.pem ngbasic-Alpha-VXX.zip ubuntu@OSAWARE_IP:/tmp/

# On Lightsail:
~/deploy-frontend.sh /tmp/ngbasic-Alpha-VXX.zip
rm /tmp/ngbasic-Alpha-VXX.zip
```

No nginx reload needed — static files are read fresh on every request. Hard refresh the browser (Cmd+Shift+R / Ctrl+Shift+R) to bypass browser cache.

### Deploy a backend code change

```bash
# On your laptop:
scp -i lightsail-key.pem osaware-backend-vXX.zip ubuntu@OSAWARE_IP:/tmp/

# On Lightsail:
cd /tmp
sudo unzip -o osaware-backend-vXX.zip -d /tmp/
sudo rsync -a /tmp/osaware-backend/ /srv/osaware/
sudo chown -R osaware:osaware /srv/osaware
sudo rm -rf /tmp/osaware-backend /tmp/osaware-backend-vXX.zip

# Reinstall deps if package.json changed
cd /srv/osaware
sudo -u osaware npm install --omit=dev

# Restart the service
sudo systemctl restart osaware

# Verify
curl https://www.osaware.com/api/health
```

### Database inspection (read-only — safe to run with service up)

```bash
sudo -u osaware sqlite3 -readonly /srv/osaware-data/osaware.db

sqlite> SELECT id, username, created_at FROM users;
sqlite> SELECT id, user_id, expires_at FROM sessions ORDER BY created_at DESC LIMIT 10;
sqlite> SELECT user_id, path, mime, size FROM user_binary_assets;
sqlite> .schema
sqlite> .quit
```

### Pull a backup to your laptop

```bash
# On your laptop:
scp -i lightsail-key.pem \
    ubuntu@OSAWARE_IP:/srv/backups/osaware-$(date +%Y%m%d).db \
    ~/osaware-backups/
```

### Delete a user (manual — no self-service yet)

```bash
sudo systemctl stop osaware
sudo -u osaware sqlite3 /srv/osaware-data/osaware.db <<EOF
DELETE FROM users WHERE username = 'someusername';
.quit
EOF

# Foreign key CASCADE automatically removes their sessions and
# binary asset metadata rows. But you need to manually delete the
# filesystem directory because SQLite can't run rm.
#
# Find the user's numeric ID BEFORE deleting the row, or just nuke
# the directory if you're cleaning up test accounts.
sudo rm -rf /srv/osaware-data/users/<user_id>/

sudo systemctl start osaware
```

### Certificate renewal check

Let's Encrypt certs expire every 90 days. The certbot timer handles renewal automatically around 30 days before expiry. To verify it's working:

```bash
sudo systemctl status certbot.timer
sudo certbot certificates
sudo certbot renew --dry-run
```

If the dry run succeeds, real renewals will work. You should also get email warnings from Let's Encrypt if a cert is within 20 days of expiry and hasn't renewed — watch for those.

---

## Troubleshooting

### "HTTPS hangs" / browser can't connect to `https://www.osaware.com/`

Most common cause: port 443 not open in the Lightsail web console firewall (separate from UFW). Check the console → Networking tab → IPv4 Firewall → ensure HTTPS (443) is in the rules list.

To diagnose further:

```bash
# Does nginx listen on 443?
sudo ss -tlnp | grep nginx
# Should show two lines: 0.0.0.0:80 and 0.0.0.0:443

# Does loopback HTTPS work? (bypasses firewall, tests cert + nginx)
curl -k -I https://localhost/
# -k ignores cert validation (cert is for www.osaware.com, not localhost)

# Does nginx config actually have an HTTPS server block?
sudo grep "listen 443" /etc/nginx/sites-available/osaware
```

### "invalid credentials" even though password is correct

Check cookie flags — the `Secure` flag requires HTTPS. If you're testing against `http://` the cookie never gets set:

```bash
# Is production mode on?
sudo systemctl show osaware | grep Environment
# Should include OSAWARE_PRODUCTION=1

# Is the browser actually sending a Set-Cookie response?
# Open devtools → Network → POST /api/login → Response headers
```

If the password is genuinely wrong, the backend returns 401 with `{"error":"invalid credentials"}` regardless of cookies.

### "service failed" after `systemctl start osaware`

```bash
sudo journalctl -u osaware -n 50 --no-pager
sudo cat /var/log/osaware/server-error.log
```

Most common causes:
- `/srv/osaware-data/` doesn't exist or wrong permissions → verify Phase 4
- `node_modules` missing → `cd /srv/osaware && sudo -u osaware npm install --omit=dev`
- Port 3000 already in use (another process) → `sudo ss -tlnp | grep 3000`
- SQLite database file corrupt → restore from `/srv/backups/` and restart

### `npm install` fails to build `better-sqlite3` or `bcrypt`

Missing build tools:

```bash
sudo apt install -y build-essential python3
cd /srv/osaware
sudo -u osaware npm install --omit=dev
```

### Duplicate `Cache-Control` headers in curl output

Something besides your site config is setting `Cache-Control`. Check:

```bash
sudo grep -rn "add_header.*[Cc]ache\|expires" /etc/nginx/ 2>/dev/null
```

If a conf.d snippet or a certbot-added file is also setting `Cache-Control`, that's the duplicate source. Edit to remove the redundancy.

### Certbot fails with "Challenge failed"

- DNS isn't resolving to this box → `dig +short www.osaware.com` from anywhere
- Lightsail firewall port 80 isn't open
- UFW isn't allowing HTTP → `sudo ufw status`
- Nginx isn't responding on port 80 → `curl -I http://localhost/`

Fix the network path first, then retry certbot.

---

## Backup recovery procedure

If the Lightsail instance is lost and you need to rebuild from scratch:

1. Provision a new Ubuntu 22.04 instance, assign the static IP
2. Re-run Phases 1-10 above (system, Node, user, directories, code upload, deps, systemd, nginx)
3. **Before starting the service,** restore the database from backup:
   ```bash
   sudo systemctl stop osaware  # if already started

   # Copy backup files from wherever you stored them off-box
   scp -i key.pem ~/osaware-backups/osaware-YYYYMMDD.db ubuntu@NEW_IP:/tmp/
   scp -i key.pem -r ~/osaware-backups/users-YYYYMMDD ubuntu@NEW_IP:/tmp/

   # On the new box:
   sudo cp /tmp/osaware-YYYYMMDD.db /srv/osaware-data/osaware.db
   sudo rsync -a /tmp/users-YYYYMMDD/ /srv/osaware-data/users/
   sudo chown -R osaware:osaware /srv/osaware-data

   sudo systemctl start osaware
   ```
4. Point DNS at the new static IP
5. Re-run certbot (fresh cert for the new box)
6. Verify with `test_api.js` and a browser sanity check

The whole recovery is 30-60 minutes if you have the backups.

---

## What's NOT in this runbook (deliberately)

These are real features a production deployment might want but are **out of scope for v1** and deliberately not wired up:

- **Email sending** (no welcome emails, no expiry warnings, no password reset via email)
- **Rate limiting** beyond what nginx and Cloudflare provide by default
- **Monitoring / alerting** (use UptimeRobot or similar — free tier is enough for a hobby instance)
- **Multi-instance / load balancing** (single box is fine for the expected scale)
- **CDN caching** (Cloudflare in front of Lightsail is straightforward if you need it)
- **WAF rules** (fail2ban is the minimum if you start seeing abuse)
- **Log aggregation** (local files are fine until you have multiple boxes)

Add them as needed. None are required for a working, secure, multi-tenant OSAWARE.

---

## Reference: file locations summary

| Path | Owner | Purpose |
|---|---|---|
| `/srv/osaware/` | `osaware:osaware` | Backend Node.js code |
| `/srv/osaware/node_modules/` | `osaware:osaware` | npm dependencies |
| `/srv/osaware-data/osaware.db` | `osaware:osaware` | SQLite database |
| `/srv/osaware-data/users/<id>/` | `osaware:osaware` | Per-user binary asset storage |
| `/srv/osaware-frontend/` | `ubuntu:www-data` | Static frontend files |
| `/srv/backups/` | `root:root` | Nightly database + filesystem backups |
| `/var/log/osaware/` | `osaware:osaware` | Application logs (stdout + stderr) |
| `/etc/systemd/system/osaware.service` | `root:root` | systemd unit file |
| `/etc/nginx/sites-available/osaware` | `root:root` | nginx site config (edited by certbot) |
| `/etc/letsencrypt/live/www.osaware.com/` | `root:root` | TLS cert files |
| `/etc/cron.daily/osaware-backup` | `root:root` | Nightly backup script |
| `~/deploy-frontend.sh` | `ubuntu:ubuntu` | Helper for future frontend deploys |

---

**This runbook is the authoritative deployment reference.** If anything in the live production deployment diverges from what's here, update this doc to match. A runbook that doesn't reflect reality is worse than no runbook.

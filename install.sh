#!/usr/bin/env bash
# Installs workflow-monitor as a systemd service on Ubuntu (OCI free tier fine).
#   sudo bash install.sh
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/workflow-monitor}
RUN_USER=${RUN_USER:-ubuntu}
SERVICE=workflow-monitor
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "run with sudo: sudo bash install.sh"; exit 1; }
command -v node >/dev/null && log "node $(node -v) already installed" || log "installing Node.js 22"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg build-essential python3
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
log "using node $(node -v), npm $(npm -v)"

id -u "$RUN_USER" >/dev/null 2>&1 || { log "creating user $RUN_USER"; adduser --disabled-password --gecos "" "$RUN_USER"; }
usermod -aG adm "$RUN_USER" 2>/dev/null || true

if [ "$SRC" != "$APP_DIR" ]; then
  log "copying $SRC -> $APP_DIR"
  mkdir -p "$APP_DIR"
  rsync -a --exclude node_modules --exclude data --exclude .env "$SRC/" "$APP_DIR/"
fi
cd "$APP_DIR"

log "installing dependencies"
npm install --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  log "creating .env (set PASSWORD before restarting the service)"
  sed -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')|" \
      -e "s|^PASSWORD=.*|PASSWORD=${ADMIN_PASSWORD:-changeme}|" \
      -e "s|^PUBLIC_URL=.*|PUBLIC_URL=http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1):4180|" \
      .env.example > .env
  chmod 600 .env
fi

log "creating systemd unit"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Workflow Monitor (server + n8n watchdog)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=-$APP_DIR/.env
SyslogIdentifier=$SERVICE
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
EOF

# Lets /restart <unit>, auto-restart and the security scan work without giving the service full root.
# `ss` and `fail2ban-client` are read-only in the app's usage; journalctl is used to read ssh logs and
# the journal: sources listed in LOG_SOURCES for the Logs page.
cat > /etc/sudoers.d/$SERVICE <<EOF
$RUN_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart *, /usr/bin/systemctl stop *, /usr/bin/systemctl is-active *, /usr/bin/journalctl *, /usr/sbin/ss *, /usr/bin/ss *, /usr/bin/fail2ban-client *
EOF
chmod 440 /etc/sudoers.d/$SERVICE

mkdir -p "$APP_DIR/data"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

systemctl daemon-reload
systemctl enable --now $SERVICE

log "done"
cat <<EOF
  service : systemctl status $SERVICE --no-pager
  logs    : journalctl -u $SERVICE -f
  dashboard http://<this-host>:4180  (password in $APP_DIR/.env)
  Edit $APP_DIR/.env then: sudo systemctl restart $SERVICE

  If a firewall is active, open the port only when you want it public:
    sudo ufw allow 4180/tcp        # or put it behind nginx + HTTPS
  Prefer PM2 instead of systemd?
    pm2 start server.js --name workflow-monitor && pm2 save
  Add another server (Agents panel -> Generate agent key), then on that box:
    HUB_URL=http://<this-host>:4180 HUB_KEY=<key> SERVER_NAME=<name> node agent/agent.js
EOF

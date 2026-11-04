#!/usr/bin/env bash
# One-time setup on a fresh server (as root): service user, checkout of the public repo,
# first build, autodeploy timer. Afterwards a push to main is a deploy.
#   curl -fsSL https://raw.githubusercontent.com/work4life2/ops-sentinel/main/deploy/server-bootstrap.sh | bash
# Then create /opt/ops-sentinel/.env.local from .env.example (chmod 600, owner opsbot) and run
#   /opt/ops-sentinel/deploy/deploy.sh --force
set -euo pipefail

TARGET="${TARGET:-/opt/ops-sentinel}"
REPO="${REPO:-https://github.com/work4life2/ops-sentinel.git}"
SERVICE_USER="${SERVICE_USER:-opsbot}"

command -v node >/dev/null || { echo "Node.js >= 22 is required" >&2; exit 1; }
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$TARGET" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$TARGET/data"
chown "$SERVICE_USER:$SERVICE_USER" "$TARGET" "$TARGET/data"
chmod 750 "$TARGET"

# Works on an empty directory and on one that already holds .env.local / data/ (both git-ignored).
cd "$TARGET"
if [ ! -d .git ]; then
  runuser -u "$SERVICE_USER" -- git init -q -b main
  runuser -u "$SERVICE_USER" -- git remote add origin "$REPO"
fi
TARGET="$TARGET" bash -c "$(runuser -u "$SERVICE_USER" -- git fetch -q origin main && runuser -u "$SERVICE_USER" -- git show origin/main:deploy/deploy.sh)" deploy --force
systemctl enable --now ops-sentinel-autodeploy.timer
echo "[bootstrap] done. Logs: journalctl -fu ops-sentinel ; deploys: journalctl -u ops-sentinel-autodeploy"

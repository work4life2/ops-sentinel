#!/usr/bin/env bash
# Pull-based deploy: fetch origin/<branch>; if it moved (or --force), reset the checkout to it,
# install, build, refresh the systemd units and restart. Runs as root every minute from
# ops-sentinel-autodeploy.timer (it drops to the service user for git/npm). Same shape as
# jev-fc-buddy/deploy/deploy.sh. .env.local and data/ are git-ignored, so the reset never touches them.
#   deploy/deploy.sh            # deploy only if origin moved
#   deploy/deploy.sh --force    # always rebuild + restart
set -euo pipefail

TARGET="${TARGET:-/opt/ops-sentinel}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-opsbot}"
SERVICE=ops-sentinel
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

as_user() { runuser -u "$SERVICE_USER" -- env HOME="$TARGET" "$@"; }

cd "$TARGET"
as_user git fetch -q origin "$BRANCH"
LOCAL="$(as_user git rev-parse -q --verify HEAD || echo none)"
REMOTE="$(as_user git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" = 0 ]; then
  exit 0
fi

echo "[deploy] $LOCAL -> $REMOTE"
as_user git reset -q --hard "origin/$BRANCH"
# deploy.sh itself may have just changed: re-run the fresh copy once instead of finishing with stale logic.
if [ "${DEPLOY_REEXEC:-}" != 1 ]; then
  DEPLOY_REEXEC=1 exec bash "$TARGET/deploy/deploy.sh" --force
fi
as_user npm ci --no-audit --no-fund --loglevel=error
as_user npm run build --silent

install -m 644 deploy/ops-sentinel.service /etc/systemd/system/$SERVICE.service
sed -i "s/User=%i/User=$SERVICE_USER/; s#/opt/ops-sentinel#$TARGET#g" /etc/systemd/system/$SERVICE.service
install -m 644 deploy/ops-sentinel-autodeploy.service deploy/ops-sentinel-autodeploy.timer /etc/systemd/system/
sed -i "s#/opt/ops-sentinel#$TARGET#g" /etc/systemd/system/ops-sentinel-autodeploy.service
systemctl daemon-reload

# No secrets yet (fresh box): build only, never start a bot that cannot connect.
if [ ! -f "$TARGET/.env.local" ]; then
  echo "[deploy] $TARGET/.env.local is missing: copy .env.example, fill it in, then: systemctl enable --now $SERVICE" >&2
  exit 0
fi
chmod 600 "$TARGET/.env.local"
systemctl enable -q "$SERVICE"
systemctl restart "$SERVICE"
echo "[deploy] done: $(as_user git log -1 --format='%h %s')"

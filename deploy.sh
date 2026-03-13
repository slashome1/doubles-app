#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="/home/jaymz/.openclaw/workspace"
APP_DIR="$WORKSPACE/projects/Doubles App"
SECRETS_FILE="$WORKSPACE/.openclaw/secrets.env"
SSH_CONFIG="$WORKSPACE/.ssh/config"
REMOTE_APP_ROOT="${DOUBLES_DEPLOY_PATH:-/mnt/user/appdata/doubles-app}"
REMOTE_APP_DIR="$REMOTE_APP_ROOT/app"
REMOTE_DATA_DIR="$REMOTE_APP_ROOT/data"
REMOTE_ENV_PATH="$REMOTE_APP_DIR/.env"

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "Missing secrets file: $SECRETS_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$SECRETS_FILE"
: "${SSH_HOST_ALIAS:?Missing SSH_HOST_ALIAS in secrets file}"
: "${GITHUB_TOKEN:?Missing GITHUB_TOKEN in secrets file}"

cd "$APP_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to deploy: local repo has uncommitted changes" >&2
  git status --short >&2
  exit 1
fi

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Refusing to deploy: expected current branch 'main', got '$BRANCH'" >&2
  exit 1
fi

echo "==> Pushing latest code to GitHub"
git push "https://${GITHUB_TOKEN}@github.com/slashome1/doubles-app.git" main

echo "==> Deploying on ${SSH_HOST_ALIAS}:${REMOTE_APP_DIR}"
ssh -F "$SSH_CONFIG" "$SSH_HOST_ALIAS" "bash -s" <<REMOTE
set -euo pipefail
APP_ROOT='$REMOTE_APP_ROOT'
APP_DIR='$REMOTE_APP_DIR'
DATA_DIR='$REMOTE_DATA_DIR'
ENV_PATH='$REMOTE_ENV_PATH'
REPO_URL='https://x-access-token:$GITHUB_TOKEN@github.com/slashome1/doubles-app.git'
mkdir -p "\$APP_DIR" "\$DATA_DIR"
if [ ! -d "\$APP_DIR/.git" ]; then
  rm -rf "\$APP_DIR"
  git clone "\$REPO_URL" "\$APP_DIR"
fi
cd "\$APP_DIR"
git config --global credential.helper 'store --file=/root/.git-credentials'
printf '%s\n' 'https://x-access-token:$GITHUB_TOKEN@github.com' > /root/.git-credentials
chmod 600 /root/.git-credentials
git config --global --add safe.directory "\$APP_DIR"
git fetch origin
git checkout main
git pull --ff-only origin main
if [ ! -f "\$ENV_PATH" ]; then
  cat > "\$ENV_PATH" <<ENVEOF
PORT=3000
SESSION_SECRET=$(openssl rand -hex 32)
ADMIN_USERNAME=admin
ADMIN_PIN=1234
USER_USERNAME=user
USER_PIN=1111
DATA_DIR=/app/data
ENVEOF
fi
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d --build
else
  echo 'Docker compose not available' >&2
  exit 1
fi
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -fsS http://127.0.0.1:3000/login | grep -q '<title>Doubles App</title>'; then
    echo 'Healthcheck passed'
    exit 0
  fi
  sleep 2
done
echo 'Healthcheck failed: Doubles App did not respond as expected on port 3000' >&2
exit 1
REMOTE

echo "==> Deploy complete"

#!/bin/zsh

set -euo pipefail

SCRIPT_DIRECTORY="${0:A:h}"
PROJECT_DIRECTORY="${SCRIPT_DIRECTORY:h}"
cd "$PROJECT_DIRECTORY"

if [[ -f .env.local ]]; then
  set -a
  source .env.local
  set +a
fi

if [[ -f .env.feishu.local ]]; then
  set -a
  source .env.feishu.local
  set +a
fi

NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
PNPM_BIN="${PNPM_BIN:-/opt/homebrew/bin/pnpm}"
AGENT_SCHEDULE_EDITION="${AGENT_SCHEDULE_EDITION:-daily}"
AGENT_SCHEDULE_MAX_ATTEMPTS="${AGENT_SCHEDULE_MAX_ATTEMPTS:-3}"
AGENT_SCHEDULE_RETRY_BASE_SECONDS="${AGENT_SCHEDULE_RETRY_BASE_SECONDS:-30}"

if [[ ! "$AGENT_SCHEDULE_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  print -u2 "AGENT_SCHEDULE_MAX_ATTEMPTS must be a positive integer."
  exit 2
fi

if [[ ! "$AGENT_SCHEDULE_RETRY_BASE_SECONDS" =~ ^[0-9]+$ ]]; then
  print -u2 "AGENT_SCHEDULE_RETRY_BASE_SECONDS must be a non-negative integer."
  exit 2
fi

"$PNPM_BIN" build
"$NODE_BIN" --env-file-if-exists=.env.local --env-file-if-exists=.env.feishu.local \
  apps/cli/dist/index.js migrate

attempt=1

while (( attempt <= AGENT_SCHEDULE_MAX_ATTEMPTS )); do
  if "$NODE_BIN" --env-file-if-exists=.env.local --env-file-if-exists=.env.feishu.local \
    apps/cli/dist/index.js run-live \
    --edition "$AGENT_SCHEDULE_EDITION"; then
    exit 0
  fi

  if (( attempt == AGENT_SCHEDULE_MAX_ATTEMPTS )); then
    print -u2 "Daily agent run failed after ${attempt} attempt(s)."
    "$NODE_BIN" --env-file-if-exists=.env.local --env-file-if-exists=.env.feishu.local \
      apps/cli/dist/index.js notify-failure --edition "$AGENT_SCHEDULE_EDITION" || \
      print -u2 "The Feishu failure alert could not be sent."
    exit 1
  fi

  delay=$(( AGENT_SCHEDULE_RETRY_BASE_SECONDS * (2 ** (attempt - 1)) ))
  print -u2 "Daily agent run attempt ${attempt} failed; retrying in ${delay}s."
  sleep "$delay"
  attempt=$(( attempt + 1 ))
done

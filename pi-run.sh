#!/bin/bash
# Daily AQI scoring cron script — runs on the Raspberry Pi.
# Scores yesterday (Pacific midnight-to-midnight) from local SQLite,
# writes scores/YYYY-MM-DD.json + manifest.json, then uploads both to R2.
#
# Crontab entry (adjust path to node if not using nvm):
#   1 0 * * * /home/pihead/aqi-impact/pi-run.sh >> /home/pihead/aqi-impact/logs/cron.log 2>&1
#
# If the Pi uses nvm, prepend the nvm bin dir:
#   PATH=/home/pihead/.nvm/versions/node/v24.16.0/bin:$PATH
#   1 0 * * * PATH=/home/pihead/.nvm/versions/node/v24.16.0/bin:$PATH /home/pihead/aqi-impact/pi-run.sh >> ...

set -euo pipefail

PROJECT=/home/pihead/aqi-impact
LOG=$PROJECT/logs/cron.log

mkdir -p "$PROJECT/logs"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ── AQI scoring run started ──" >> "$LOG"

# Load .env for R2 credentials (AQI_DB_PATH hardcoded below takes precedence)
set -a
[[ -f "$PROJECT/.env" ]] && source "$PROJECT/.env"
set +a

# Pi-specific DB path — always wins over any .env value
export AQI_DB_PATH=/home/pihead/enviro-lite/environment

cd "$PROJECT"
node node_modules/.bin/tsx --env-file=.env scripts/score-from-sqlite.ts >> "$LOG" 2>&1

# ── Upload to Cloudflare R2 ───────────────────────────────────────────────────
# Skipped automatically if R2 vars are not set (local-only / pre-deployment mode).
if [[ -n "${CF_ACCOUNT_ID:-}" && -n "${R2_BUCKET:-}" && -n "${R2_ACCESS_KEY_ID:-}" ]]; then
  SCORED_DATE=$(node -e "process.stdout.write(new Date(Date.now()-86400000).toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'}))")
  R2_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Uploading ${SCORED_DATE}.json + manifest.json to R2..." >> "$LOG"

  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  aws s3 cp "$PROJECT/site/public/scores/${SCORED_DATE}.json" \
    "s3://${R2_BUCKET}/scores/${SCORED_DATE}.json" \
    --endpoint-url "$R2_ENDPOINT" --no-progress >> "$LOG" 2>&1

  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  aws s3 cp "$PROJECT/site/public/scores/manifest.json" \
    "s3://${R2_BUCKET}/scores/manifest.json" \
    --endpoint-url "$R2_ENDPOINT" --no-progress >> "$LOG" 2>&1

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] R2 upload complete" >> "$LOG"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] R2 not configured — skipping upload" >> "$LOG"
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ── Run complete ──" >> "$LOG"

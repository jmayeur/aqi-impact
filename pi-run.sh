#!/bin/bash
# Daily AQI scoring cron script — runs on the Raspberry Pi.
# Scores yesterday (Pacific midnight-to-midnight) from local SQLite,
# writes scores/YYYY-MM-DD.json and updates scores/manifest.json.
#
# Crontab entry (adjust path to node if not using nvm):
#   1 0 * * * /home/pihead/aqi-impact/pi-run.sh >> /home/pihead/aqi-impact/logs/cron.log 2>&1
#
# If the Pi uses nvm, prepend the nvm bin dir:
#   PATH=/home/pihead/.nvm/versions/node/v24.16.0/bin:$PATH
#   1 0 * * * PATH=/home/pihead/.nvm/versions/node/v24.16.0/bin:$PATH /home/pihead/aqi-impact/pi-run.sh >> ...

set -euo pipefail

export AQI_DB_PATH=/home/pihead/enviro-lite/environment
PROJECT=/home/pihead/aqi-impact
LOG=$PROJECT/logs/cron.log

mkdir -p "$PROJECT/logs"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ── AQI scoring run started ──" >> "$LOG"

cd "$PROJECT"
node node_modules/.bin/tsx --env-file=.env scripts/score-from-sqlite.ts >> "$LOG" 2>&1

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ── Run complete ──" >> "$LOG"

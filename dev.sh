#!/bin/bash
# Start the Astro dev server. Requires Node 24 on PATH.
export NVM_DIR="$HOME/.nvm"
[[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh" && nvm use 24 --silent
cd "$(dirname "$0")/site"
exec npm run dev

#!/bin/bash
# Start the Astro dev server. Requires Node 24 on PATH.
export NVM_DIR="$HOME/.nvm"
[[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh" && nvm use 24 --silent

SITE_DIR="$(dirname "$0")/site"

# Install site deps if missing
if [ ! -d "$SITE_DIR/node_modules" ]; then
  echo "Installing site dependencies..."
  npm install --prefix "$SITE_DIR"
fi

exec npm run dev --prefix "$SITE_DIR"

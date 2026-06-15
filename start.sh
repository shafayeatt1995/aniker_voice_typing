#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if pgrep -x ydotoold >/dev/null 2>&1; then
  echo "ydotoold already running"
else
  echo "Starting ydotoold (sudo)..."
  sudo ydotoold &
  sleep 1
fi

echo "Starting server..."
exec bun run server.ts

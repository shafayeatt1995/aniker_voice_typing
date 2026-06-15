#!/usr/bin/env bash
set -euo pipefail

USER_NAME="${USER:-$(whoami)}"
SUDOERS_FILE="/etc/sudoers.d/phone-voice-paste"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
YDOTOOL_WRAPPER="${SCRIPT_DIR}/scripts/ydotool-sudo.sh"

chmod +x "$YDOTOOL_WRAPPER"

echo "Allowing passwordless ydotool wrapper (for sudo ydotoold)..."
echo "${USER_NAME} ALL=(ALL) NOPASSWD: ${YDOTOOL_WRAPPER}" | sudo tee "$SUDOERS_FILE" >/dev/null
sudo chmod 440 "$SUDOERS_FILE"
sudo visudo -cf "$SUDOERS_FILE"

echo "Done. Restart: bun run dev"

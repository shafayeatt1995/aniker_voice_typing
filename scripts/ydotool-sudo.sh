#!/usr/bin/env bash
# Wrapper for passwordless sudo — sets root ydotool socket path.
export YDOTOOL_SOCKET=/tmp/.ydotool_socket
exec /usr/bin/ydotool "$@"

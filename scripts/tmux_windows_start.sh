#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="${WORKBENCH_TMUX_SESSION:-workbench}"
SERVER="${WORKBENCH_TMUX_SERVER:-workbench}"
STATE_DIR="${WORKBENCH_STATE_DIR:-$ROOT/.workbench}"
PERSIST="${WORKBENCH_TMUX_PERSIST:-0}"

if ! command -v tmux >/dev/null 2>&1; then
  exec bun "$ROOT/ui/tui/ink-entry.js"
fi

# Initialize state directory and pointer file
mkdir -p "$STATE_DIR/state"
if [[ ! -f "$STATE_DIR/state/current.json" ]]; then
  echo '{"schemaVersion":1,"updatedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$STATE_DIR/state/current.json"
fi

STATE_DIR_ABS="$(cd "$STATE_DIR" && pwd)"

tmux_has_window() {
  local name="$1"
  tmux -L "$SERVER" list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -Fxq "$name"
}

ensure_session() {
  if tmux -L "$SERVER" has-session -t "$SESSION" 2>/dev/null; then
    return 0
  fi

  tmux -L "$SERVER" new-session -d -s "$SESSION" -n "control" \
    "bash -lc 'cd \"$ROOT\" && WORKBENCH_STATE_DIR=\"$STATE_DIR_ABS\" WORKBENCH_TMUX_SESSION=\"$SESSION\" bun ui/tui/ink-entry.js; rc=\$?; echo \"[workbench] control window exited (rc=\$rc)\"; exec bash'"
}

ensure_window() {
  local name="$1"; shift
  local cmd="$*"
  if tmux_has_window "$name"; then
    return 0
  fi
  tmux -L "$SERVER" new-window -d -t "$SESSION" -n "$name" -c "$ROOT" "bash -lc \"$cmd\""
}

ensure_session

# Default behavior: if you close the tmux client, tear down the workbench session.
# Use a hook rather than `destroy-unattached` to avoid racing our initial attach.
if [[ "$PERSIST" != "1" ]]; then
  tmux -L "$SERVER" set-hook -t "$SESSION" client-detached "if-shell -F '#{==:#{session_attached},0}' 'kill-session -t \"$SESSION\"' ''" 2>/dev/null || true
fi

# Mouse enables: click-to-focus panes + drag-to-resize split dividers + wheel scroll (copy-mode)
tmux -L "$SERVER" set-option -g mouse on 2>/dev/null || true
tmux -L "$SERVER" set-option -g focus-events on 2>/dev/null || true

# Dedicated windows (no embedded status UI required)
ensure_window "control" "cd \"$ROOT\" && WORKBENCH_STATE_DIR=\"$STATE_DIR_ABS\" WORKBENCH_TMUX_SESSION=\"$SESSION\" bun ui/tui/ink-entry.js; rc=\$?; echo \"[workbench] control window exited (rc=\$rc)\"; exec bash"
ensure_window "ui" "cd \"$ROOT\" && exec bash"
ensure_window "status" "cd \"$ROOT\" && WORKBENCH_STATE_DIR=\"$STATE_DIR_ABS\" WORKBENCH_TMUX_SESSION=\"$SESSION\" bun ui/tui/status-pane-entry.jsx"
ensure_window "output" "cd \"$ROOT\" && exec bash"

bash "$ROOT/scripts/tmux_theme.sh" "$SESSION" || true

tmux -L "$SERVER" select-window -t "$SESSION:control" 2>/dev/null || tmux -L "$SERVER" select-window -t "$SESSION" 2>/dev/null || true
exec tmux -L "$SERVER" attach -t "$SESSION"
